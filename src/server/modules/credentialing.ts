import { z } from 'zod';
import { one, query, withTx, type Db } from '../db';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { authorizeOrg, requirePlatform } from './authz';
import { slugify } from './orgs';

// ---------------------------------------------------------------------------
// Identidade profissional: cópia de trabalho -> versão enviada -> aprovação humana
// ---------------------------------------------------------------------------
async function ownPractitioner(actor: string, org: string, practitionerId: string) {
  const g = await authorizeOrg(actor, org, 'profile.manage');
  if (!g.allowsPractitioner(practitionerId)) throw forbidden();
  const p = await one<any>('SELECT * FROM practitioners WHERE id=$1', [practitionerId]);
  if (!p) throw notFound();
  return p;
}

export const identitySchema = z.object({
  displayName: z.string().trim().min(3).max(120),
  registrations: z.array(z.object({ uf: z.string().length(2).toUpperCase(), number: z.string().regex(/^\d{1,10}$/) })).min(1).max(5),
  specialties: z.array(z.object({ specialtyId: z.string().uuid(), rqe: z.string().regex(/^\d{1,10}$/).nullish() })).min(1).max(6),
});

/** Salva a cópia de trabalho. Não altera a publicação: isso só ocorre por aprovação da revisão. */
export async function saveIdentity(actor: string, org: string, practitionerId: string, raw: z.input<typeof identitySchema>) {
  const p = await ownPractitioner(actor, org, practitionerId);
  const i = identitySchema.parse(raw);
  await withTx(async (tx) => {
    await tx.query('UPDATE practitioners SET display_name=$2, updated_at=now() WHERE id=$1', [p.id, i.displayName]);
    await tx.query('DELETE FROM professional_registrations WHERE practitioner_id=$1', [p.id]);
    for (const r of i.registrations) {
      try {
        await tx.query("INSERT INTO professional_registrations(practitioner_id, uf, number) VALUES ($1,$2,$3)", [p.id, r.uf, r.number]);
      } catch (e: any) {
        if (e.code === '23505') throw conflict('registration_in_use', 'Esta inscrição já está vinculada a outra identidade profissional');
        throw e;
      }
    }
    await tx.query('DELETE FROM practitioner_specialties WHERE practitioner_id=$1', [p.id]);
    for (const s of i.specialties) {
      await tx.query('INSERT INTO practitioner_specialties(practitioner_id, specialty_id, rqe) VALUES ($1,$2,$3)', [p.id, s.specialtyId, s.rqe ?? null]);
    }
    await audit({ actorUserId: actor, organizationId: org, action: 'practitioner.identity_saved', objectType: 'practitioner', objectId: p.id }, tx);
  });
}

async function snapshot(db: Db, practitionerId: string) {
  const p = await one<any>('SELECT display_name FROM practitioners WHERE id=$1', [practitionerId], db);
  const regs = await query('SELECT council, uf, number FROM professional_registrations WHERE practitioner_id=$1 ORDER BY uf, number', [practitionerId], db);
  const specs = await query(
    `SELECT s.id AS specialty_id, s.name, ps.rqe FROM practitioner_specialties ps JOIN specialties s ON s.id=ps.specialty_id
      WHERE ps.practitioner_id=$1 ORDER BY s.name`, [practitionerId], db);
  return { display_name: p.display_name, registrations: regs, specialties: specs };
}

/** Envia a identidade atual para revisão. Se já havia versão aprovada, ela segue publicada até a nova ser aprovada (AC07). */
export async function submitForReview(actor: string, org: string, practitionerId: string) {
  const p = await ownPractitioner(actor, org, practitionerId);
  return withTx(async (tx) => {
    const snap = await snapshot(tx, p.id);
    if (!snap.display_name || !snap.registrations.length || !snap.specialties.length) {
      throw badRequest('identity_incomplete', 'Informe nome profissional, CRM/UF e ao menos uma especialidade');
    }
    await tx.query("UPDATE public_profile_versions SET status='superseded' WHERE practitioner_id=$1 AND status IN ('pending_review','needs_changes')", [p.id]);
    const last = await one<{ v: number }>('SELECT COALESCE(max(version),0) v FROM public_profile_versions WHERE practitioner_id=$1', [p.id], tx);
    const v = await one<{ id: string }>(
      "INSERT INTO public_profile_versions(practitioner_id, version, data) VALUES ($1,$2,$3) RETURNING id",
      [p.id, last!.v + 1, JSON.stringify(snap)], tx);
    if (!p.current_public_version_id) {
      await tx.query("UPDATE practitioners SET status='pending_review', status_reason=NULL, updated_at=now() WHERE id=$1", [p.id]);
    }
    await audit({ actorUserId: actor, organizationId: org, action: 'credential.submitted', objectType: 'practitioner', objectId: p.id, metadata: { versionId: v!.id } }, tx);
    return { versionId: v!.id };
  });
}

export async function listReviewQueue(actor: string) {
  await requirePlatform(actor, 'credential.review');
  return query(
    `SELECT v.id AS version_id, v.version, v.submitted_at, v.data, p.id AS practitioner_id, p.status,
            (p.current_public_version_id IS NOT NULL) AS has_published
       FROM public_profile_versions v JOIN practitioners p ON p.id = v.practitioner_id
      WHERE v.status='pending_review' ORDER BY v.submitted_at`);
}

export const reviewSchema = z.object({
  decision: z.enum(['approve', 'needs_changes', 'reject']),
  notes: z.string().max(1000).optional(),
  evidence: z.object({
    source: z.string().min(3), registration: z.string().min(3), situation: z.string().min(2),
    checkedAt: z.string().date(), nextReviewAt: z.string().date(),
  }).optional(),
});

/** A verificação é SEMPRE manual/registrada: fonte, data, responsável, inscrição, situação e próxima revisão. */
export async function reviewVersion(actor: string, versionId: string, raw: z.input<typeof reviewSchema>) {
  await requirePlatform(actor, 'credential.review');
  const r = reviewSchema.parse(raw);
  return withTx(async (tx) => {
    const v = await one<any>('SELECT * FROM public_profile_versions WHERE id=$1 FOR UPDATE', [versionId], tx);
    if (!v || v.status !== 'pending_review') throw notFound('version_not_pending');
    const p = await one<any>('SELECT * FROM practitioners WHERE id=$1 FOR UPDATE', [v.practitioner_id], tx);
    if (r.decision === 'approve') {
      if (!r.evidence) throw badRequest('evidence_required', 'Registre a evidência da verificação (fonte, data, inscrição, situação, próxima revisão)');
      const slug = p.slug ?? (await (await import('./orgs')).uniqueSlug('practitioners', v.data.display_name, tx));
      await tx.query("UPDATE public_profile_versions SET status='superseded' WHERE practitioner_id=$1 AND status='approved'", [p.id]);
      await tx.query("UPDATE public_profile_versions SET status='approved', reviewed_at=now(), reviewed_by=$2, review_notes=$3 WHERE id=$1", [versionId, actor, r.notes ?? null]);
      await tx.query(
        `UPDATE practitioners SET current_public_version_id=$2, slug=$3, status=CASE WHEN status='suspended' THEN 'suspended' ELSE 'approved' END,
                status_reason=CASE WHEN status='suspended' THEN status_reason ELSE NULL END, next_review_at=$4, updated_at=now() WHERE id=$1`,
        [p.id, versionId, slug, r.evidence.nextReviewAt]);
      await tx.query(
        `INSERT INTO credential_checks(practitioner_id, profile_version_id, source, registration, registration_situation, checked_at, checked_by, next_review_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, versionId, r.evidence.source, r.evidence.registration, r.evidence.situation, r.evidence.checkedAt, actor, r.evidence.nextReviewAt, r.notes ?? null]);
    } else {
      const st = r.decision === 'reject' ? 'rejected' : 'needs_changes';
      await tx.query("UPDATE public_profile_versions SET status=$2, reviewed_at=now(), reviewed_by=$3, review_notes=$4 WHERE id=$1", [versionId, st, actor, r.notes ?? null]);
      if (!p.current_public_version_id) {
        await tx.query('UPDATE practitioners SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1', [p.id, st, r.notes ?? null]);
      }
    }
    await audit({ actorUserId: actor, action: `credential.${r.decision}`, objectType: 'practitioner', objectId: p.id, metadata: { versionId } }, tx);
    return { ok: true };
  });
}

/** Suspensão: bloqueia novas marcações; consultas existentes são preservadas e sinalizadas para contato. */
export async function suspendPractitioner(actor: string, practitionerId: string, reason: string) {
  await requirePlatform(actor, 'credential.review');
  if (!reason || reason.length < 5) throw badRequest('reason_required');
  await withTx(async (tx) => {
    const p = await one('SELECT id FROM practitioners WHERE id=$1 FOR UPDATE', [practitionerId], tx);
    if (!p) throw notFound();
    await tx.query("UPDATE practitioners SET status='suspended', status_reason=$2, updated_at=now() WHERE id=$1", [practitionerId, reason]);
    await tx.query("UPDATE slot_holds SET status='released' WHERE practitioner_id=$1 AND status='active'", [practitionerId]);
    await tx.query("DELETE FROM practitioner_occupancies WHERE practitioner_id=$1 AND kind='hold'", [practitionerId]);
    const affected = await query<{ id: string }>(
      `UPDATE appointments SET needs_followup=true, followup_reason='Profissional suspenso: contato e solução com o paciente', updated_at=now()
        WHERE practitioner_id=$1 AND status IN ('scheduled','pending_approval') AND starts_at > now() RETURNING id`, [practitionerId], tx);
    await tx.query(
      `INSERT INTO outbox_events(event_type, payload) VALUES ('PractitionerSuspended', $1)`,
      [JSON.stringify({ practitionerId, affectedAppointmentIds: affected.map((a) => a.id) })]);
    await audit({ actorUserId: actor, action: 'credential.suspended', objectType: 'practitioner', objectId: practitionerId, reason, metadata: { affected: affected.length } }, tx);
  });
}

export async function reinstatePractitioner(actor: string, practitionerId: string, reason: string) {
  await requirePlatform(actor, 'credential.review');
  if (!reason || reason.length < 5) throw badRequest('reason_required');
  const p = await one<any>('SELECT current_public_version_id FROM practitioners WHERE id=$1', [practitionerId]);
  if (!p) throw notFound();
  await query("UPDATE practitioners SET status=$2, status_reason=NULL, updated_at=now() WHERE id=$1", [practitionerId, p.current_public_version_id ? 'approved' : 'draft']);
  await audit({ actorUserId: actor, action: 'credential.reinstated', objectType: 'practitioner', objectId: practitionerId, reason });
}

/** Campos públicos de baixo risco: não exigem nova análise documental. */
export const publicFieldsSchema = z.object({
  bio: z.string().max(1500).optional(),
  languages: z.array(z.string().min(2).max(30)).max(8).optional(),
  ageMin: z.number().int().min(0).max(120).nullish(),
  ageMax: z.number().int().min(0).max(120).nullish(),
  travelBufferMinutes: z.number().int().min(0).max(240).optional(),
});
export async function updatePublicFields(actor: string, org: string, practitionerId: string, raw: z.input<typeof publicFieldsSchema>) {
  const p = await ownPractitioner(actor, org, practitionerId);
  const f = publicFieldsSchema.parse(raw);
  await query(
    `UPDATE practitioners SET bio=COALESCE($2,bio), languages=COALESCE($3,languages), age_min=$4, age_max=$5,
            travel_buffer_minutes=COALESCE($6,travel_buffer_minutes), updated_at=now() WHERE id=$1`,
    [p.id, f.bio ? stripHtml(f.bio) : null, f.languages ?? null, f.ageMin ?? null, f.ageMax ?? null, f.travelBufferMinutes ?? null]);
  await audit({ actorUserId: actor, organizationId: org, action: 'practitioner.public_fields_updated', objectType: 'practitioner', objectId: p.id });
}
/** Conteúdo de perfil é texto puro (sem HTML) — mitigação de XSS na origem; a UI também escapa. */
export const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');

export async function myPractitioners(actor: string) {
  return query(
    `SELECT p.id, p.display_name, p.status, p.status_reason, p.slug, p.current_public_version_id,
            (SELECT status FROM public_profile_versions v WHERE v.practitioner_id=p.id ORDER BY version DESC LIMIT 1) AS latest_version_status
       FROM practitioners p WHERE p.user_id=$1`, [actor]);
}
export { slugify };
