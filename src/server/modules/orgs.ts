import { z } from 'zod';
import { one, query, withTx, pool, type Db } from '../db';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound, AppError } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import { sendEmail } from '../lib/email';
import { config } from '../config';
import { authorizeOrg } from './authz';
import { revokeAllSessions, emailSchema } from './identity';
import { recordAcceptance } from './documents';
import { assertWithinLimit } from './entitlements';

export const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export async function uniqueSlug(table: 'organizations' | 'practitioners', base: string, db: Db = pool()) {
  const root = slugify(base) || 'perfil';
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const r = await one(`SELECT 1 FROM ${table} WHERE slug=$1`, [candidate], db);
    if (!r) return candidate;
  }
  throw new AppError(500, 'slug_generation_failed');
}

export const createOrgSchema = z.object({
  kind: z.enum(['individual', 'clinic']),
  name: z.string().trim().min(2).max(120),
  asPractitioner: z.boolean().default(false),
  acceptContract: z.literal(true, { error: 'Aceite do contrato é obrigatório' }),
});

/** Cria organização; o criador vira gestor (e médico, se solicitado). Requer e-mail verificado. */
export async function createOrganization(userId: string, raw: z.input<typeof createOrgSchema>) {
  const input = createOrgSchema.parse(raw);
  const u = await one<{ email_verified_at: string | null; full_name: string }>('SELECT email_verified_at, full_name FROM users WHERE id=$1', [userId]);
  if (!u?.email_verified_at) throw forbidden('email_not_verified', 'Confirme seu e-mail antes de criar uma organização');
  return withTx(async (tx) => {
    const slug = await uniqueSlug('organizations', input.name, tx);
    const org = await one<{ id: string }>(
      'INSERT INTO organizations(kind, name, slug, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [input.kind, input.name, slug, userId], tx);
    const acc = await recordAcceptance(tx, userId, 'contrato-profissional', org!.id, { via: 'criacao_organizacao' });
    await tx.query("INSERT INTO memberships(user_id, organization_id, role_id) VALUES ($1,$2,'clinic_manager')", [userId, org!.id]);
    let practitionerId: string | null = null;
    if (input.asPractitioner) {
      practitionerId = await ensurePractitionerFor(tx, userId, org!.id);
      await tx.query("INSERT INTO memberships(user_id, organization_id, role_id) VALUES ($1,$2,'practitioner')", [userId, org!.id]);
    }
    await audit({ actorUserId: userId, organizationId: org!.id, action: 'org.created', objectType: 'organization', objectId: org!.id,
      metadata: { kind: input.kind, acceptanceId: acc.id } }, tx);
    return { organizationId: org!.id, slug, practitionerId };
  });
}

/** Cria (ou reaproveita) a identidade profissional global do usuário e vincula à organização. */
export async function ensurePractitionerFor(db: Db, userId: string, organizationId: string): Promise<string> {
  let p = await one<{ id: string }>('SELECT id FROM practitioners WHERE user_id=$1', [userId], db);
  if (!p) p = await one<{ id: string }>('INSERT INTO practitioners(user_id) VALUES ($1) RETURNING id', [userId], db);
  await db.query(
    `INSERT INTO practitioner_memberships(organization_id, practitioner_id) VALUES ($1,$2)
     ON CONFLICT (organization_id, practitioner_id) DO UPDATE SET status='active'`, [organizationId, p!.id]);
  return p!.id;
}

export async function listMyOrganizations(userId: string) {
  return query(
    `SELECT o.id, o.name, o.slug, o.kind, array_agg(m.role_id ORDER BY m.role_id) AS roles
       FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id=$1 AND m.status='active' AND o.status='active' GROUP BY o.id ORDER BY o.name`, [userId]);
}

// ---------------- Convites e equipe ----------------
export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(['clinic_manager', 'practitioner', 'secretary', 'finance']),
  practitionerIds: z.array(z.string().uuid()).default([]),
  locationIds: z.array(z.string().uuid()).default([]),
});

export async function inviteMember(actorId: string, organizationId: string, raw: z.input<typeof inviteSchema>) {
  await authorizeOrg(actorId, organizationId, 'org.members.manage');
  const input = inviteSchema.parse(raw);
  if (input.role === 'secretary' && input.practitionerIds.length + input.locationIds.length === 0) {
    throw badRequest('scope_required', 'Secretária precisa de médicos ou unidades atribuídos');
  }
  // escopos só podem referenciar recursos da MESMA organização
  for (const pid of input.practitionerIds) {
    if (!(await one('SELECT 1 FROM practitioner_memberships WHERE organization_id=$1 AND practitioner_id=$2', [organizationId, pid]))) throw badRequest('invalid_scope');
  }
  for (const lid of input.locationIds) {
    if (!(await one('SELECT 1 FROM locations WHERE organization_id=$1 AND id=$2', [organizationId, lid]))) throw badRequest('invalid_scope');
  }
  await assertWithinLimit(organizationId, 'members', { extra: 1 });
  const token = randomToken(32);
  const scopes = [
    ...input.practitionerIds.map((id) => ({ type: 'practitioner', id })),
    ...input.locationIds.map((id) => ({ type: 'location', id })),
  ];
  const inv = await one<{ id: string }>(
    `INSERT INTO invitations(organization_id, email, role_id, scopes, token_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days') RETURNING id`,
    [organizationId, input.email, input.role, JSON.stringify(scopes), sha256(token), actorId]);
  await sendEmail({
    to: input.email, subject: 'Convite para participar de uma organização',
    body: `Você recebeu um convite. Acesse ${config.baseUrl}/convites/${token} com a conta deste e-mail. O convite expira em 7 dias.`,
  });
  await audit({ actorUserId: actorId, organizationId, action: 'member.invited', objectType: 'invitation', objectId: inv!.id, metadata: { role: input.role } });
  return { invitationId: inv!.id, token }; // token só é devolvido para o convidante/testes; produção envia por e-mail
}

/** Aceite vinculado ao destinatário: a conta precisa ter o MESMO e-mail já verificado. */
export async function acceptInvitation(userId: string, token: string) {
  return withTx(async (tx) => {
    const inv = await one<any>(
      `SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE`, [sha256(token)], tx);
    if (!inv || inv.revoked_at || inv.accepted_at || new Date(inv.expires_at) < new Date()) throw notFound('invitation_invalid', 'Convite inválido ou expirado');
    const u = await one<{ email: string; email_verified_at: string | null }>('SELECT email, email_verified_at FROM users WHERE id=$1', [userId], tx);
    if (!u?.email_verified_at || u.email.toLowerCase() !== String(inv.email).toLowerCase()) {
      throw forbidden('invitation_recipient_mismatch', 'Este convite foi emitido para outro e-mail verificado');
    }
    const m = await one<{ id: string }>(
      `INSERT INTO memberships(user_id, organization_id, role_id) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, organization_id, role_id) DO UPDATE SET status='active', removed_at=NULL, removed_by=NULL RETURNING id`,
      [userId, inv.organization_id, inv.role_id], tx);
    for (const s of inv.scopes as { type: string; id: string }[]) {
      await tx.query('INSERT INTO member_scopes(membership_id, scope_type, scope_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [m!.id, s.type, s.id]);
    }
    if (inv.role_id === 'practitioner') await ensurePractitionerFor(tx, userId, inv.organization_id);
    await tx.query('UPDATE invitations SET accepted_at=now(), accepted_by=$2 WHERE id=$1', [inv.id, userId]);
    await audit({ actorUserId: userId, organizationId: inv.organization_id, action: 'member.joined', objectType: 'membership', objectId: m!.id, metadata: { role: inv.role_id } }, tx);
    return { organizationId: inv.organization_id as string, role: inv.role_id as string };
  });
}

export async function listMembers(actorId: string, organizationId: string) {
  await authorizeOrg(actorId, organizationId, 'org.members.manage');
  return query(
    `SELECT m.id AS membership_id, u.id AS user_id, u.full_name, u.email, m.role_id, m.status,
            COALESCE((SELECT json_agg(json_build_object('type', s.scope_type, 'id', s.scope_id)) FROM member_scopes s WHERE s.membership_id = m.id), '[]') AS scopes
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id=$1 ORDER BY m.status, u.full_name`, [organizationId]);
}

/** Remove vínculo: invalida sessões, preserva a atribuição histórica (linha permanece com status 'removed'). */
export async function removeMember(actorId: string, organizationId: string, membershipId: string) {
  await authorizeOrg(actorId, organizationId, 'org.members.manage');
  await withTx(async (tx) => {
    const m = await one<{ user_id: string; role_id: string }>(
      "SELECT user_id, role_id FROM memberships WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE", [membershipId, organizationId], tx);
    if (!m) throw notFound();
    if (m.role_id === 'clinic_manager') {
      const others = await one<{ n: string }>(
        "SELECT count(*) n FROM memberships WHERE organization_id=$1 AND role_id='clinic_manager' AND status='active' AND id <> $2", [organizationId, membershipId], tx);
      if (Number(others!.n) === 0) throw conflict('last_manager', 'A organização precisa de ao menos um gestor');
    }
    await tx.query("UPDATE memberships SET status='removed', removed_at=now(), removed_by=$2 WHERE id=$1", [membershipId, actorId]);
    await tx.query('DELETE FROM member_scopes WHERE membership_id=$1', [membershipId]);
    await revokeAllSessions(m.user_id, 'membership_removed', tx);
    if (m.role_id === 'practitioner') {
      const stillHere = await one("SELECT 1 FROM memberships WHERE user_id=$1 AND organization_id=$2 AND role_id='practitioner' AND status='active'", [m.user_id, organizationId], tx);
      if (!stillHere) await tx.query(
        `UPDATE practitioner_memberships SET status='inactive'
          WHERE organization_id=$1 AND practitioner_id IN (SELECT id FROM practitioners WHERE user_id=$2)`, [organizationId, m.user_id]);
    }
    await audit({ actorUserId: actorId, organizationId, action: 'member.removed', objectType: 'membership', objectId: membershipId, metadata: { role: m.role_id } }, tx);
  });
}

export async function setSecretaryScopes(actorId: string, organizationId: string, membershipId: string, scopes: { type: 'practitioner' | 'location'; id: string }[]) {
  await authorizeOrg(actorId, organizationId, 'org.members.manage');
  await withTx(async (tx) => {
    const m = await one("SELECT 1 FROM memberships WHERE id=$1 AND organization_id=$2 AND status='active' AND role_id='secretary'", [membershipId, organizationId], tx);
    if (!m) throw notFound();
    await tx.query('DELETE FROM member_scopes WHERE membership_id=$1', [membershipId]);
    for (const s of scopes) {
      const ok = s.type === 'practitioner'
        ? await one('SELECT 1 FROM practitioner_memberships WHERE organization_id=$1 AND practitioner_id=$2', [organizationId, s.id], tx)
        : await one('SELECT 1 FROM locations WHERE organization_id=$1 AND id=$2', [organizationId, s.id], tx);
      if (!ok) throw badRequest('invalid_scope');
      await tx.query('INSERT INTO member_scopes(membership_id, scope_type, scope_id) VALUES ($1,$2,$3)', [membershipId, s.type, s.id]);
    }
    await audit({ actorUserId: actorId, organizationId, action: 'member.scopes_changed', objectType: 'membership', objectId: membershipId }, tx);
  });
}
