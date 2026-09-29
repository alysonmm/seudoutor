import { z } from 'zod';
import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { one, query, withTx, pool, type Db } from '../db';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { rateLimit } from '../lib/rate-limit';
import { setting } from '../lib/settings';
import { idempotent, type IdemResult } from '../lib/idempotency';
import { authorizeOrg, requirePatientAccount, type Grant } from './authz';
import { computeSlots, isOffered, loadOffering, occupancyRange, type Offering, type Slot } from './availability';
import { BOOKABLE_SQL } from './search';
import { currentVersion } from './documents';

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
async function assertBookable(tx: Db, offeringId: string) {
  const ok = await one(
    `SELECT 1 FROM practitioner_services ps
       JOIN practitioners p ON p.id = ps.practitioner_id
       JOIN practitioner_memberships pm ON pm.practitioner_id = p.id AND pm.organization_id = ps.organization_id
       JOIN organizations o ON o.id = ps.organization_id
       JOIN locations l ON l.id = ps.location_id
      WHERE ps.id=$1 AND ${BOOKABLE_SQL}`, [offeringId], tx);
  // Profissional pendente/suspenso, sem assinatura vigente, etc. => bloqueado pelo backend (AC06).
  if (!ok) throw new AppError(409, 'practitioner_not_bookable', 'Este profissional não está disponível para marcações no momento');
}

/** Remove reservas temporárias vencidas do profissional; vencimento é lógico, não depende de job (AC12). */
async function purgeExpiredHolds(tx: Db, practitionerId: string) {
  await tx.query(`DELETE FROM practitioner_occupancies WHERE practitioner_id=$1 AND kind='hold' AND expires_at <= now()`, [practitionerId]);
  await tx.query(`UPDATE slot_holds SET status='expired' WHERE practitioner_id=$1 AND status='active' AND expires_at <= now()`, [practitionerId]);
}

async function alternatives(o: Offering, around: Date, db: Db = pool()): Promise<Slot[]> {
  const d = DateTime.fromJSDate(around, { zone: o.timezone });
  const slots = await computeSlots(o, d.toISODate()!, d.plus({ days: 7 }).toISODate()!, {}, db);
  return slots.slice(0, 5);
}

async function insertOccupancy(tx: Db, o: Offering, start: Date, kind: 'hold' | 'appointment', refId: string, expiresAt: Date | null) {
  const { lower, upper } = occupancyRange(o, start);
  const row = await one<{ id: string }>(
    `INSERT INTO practitioner_occupancies(practitioner_id, during, kind, ref_id, expires_at)
     VALUES ($1, tstzrange($2,$3,'[)'), $4, $5, $6) RETURNING id`,
    [o.practitioner_id, lower, upper, kind, refId, expiresAt], tx);
  return row!.id;
}

/**
 * Conflito de exclusão (23P01) aborta a transação; as alternativas são calculadas DEPOIS do rollback, fora dela
 * (`withAlternatives`), para não pedir uma segunda conexão ao pool enquanto esta transação segura uma (deadlock sob carga).
 */
async function guardConflict<T>(o: Offering, start: Date, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    if (e?.code === '23P01') throw conflict('slot_conflict', 'Este horário acabou de ser ocupado. Escolha outro.', { _alt: { offeringId: o.id, start: start.toISOString() } });
    throw e;
  }
}
async function withAlternatives<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e: any) {
    const alt = e instanceof AppError && e.code === 'slot_conflict' && (e.details as any)?._alt;
    if (alt) {
      const o = await loadOffering(alt.offeringId);
      throw conflict('slot_conflict', e.message, { alternatives: o ? await alternatives(o, new Date(alt.start)) : [] });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Reserva temporária
// ---------------------------------------------------------------------------
export const holdSchema = z.object({ offeringId: z.string().uuid(), startsAt: z.string().datetime() });

export async function createHold(userId: string, raw: z.input<typeof holdSchema>, idemKey?: string) {
  const b = holdSchema.parse(raw);
  await rateLimit(`hold:${userId}`, await setting<number>('hold_rate_limit_per_10min', 20), 600);
  return withAlternatives(() => idempotent(userId, 'hold', idemKey, b, async (tx) => {
    const o = await loadOffering(b.offeringId, tx);
    if (!o) throw notFound('offering_not_found');
    const start = new Date(b.startsAt);
    await assertBookable(tx, o.id);
    if (!(await isOffered(o, start, { ignoreOccupancy: true }, tx))) throw conflict('slot_not_offered', 'Horário não oferecido', { alternatives: await alternatives(o, start, tx) });
    await purgeExpiredHolds(tx, o.practitioner_id);
    const ttl = await setting<number>('hold_ttl_seconds', 300, tx);
    const expires = new Date(Date.now() + ttl * 1000);
    const end = new Date(start.getTime() + o.duration_minutes * 60_000);
    const hold = await one<{ id: string }>(
      `INSERT INTO slot_holds(organization_id, practitioner_id, location_id, practitioner_service_id, user_id, starts_at, ends_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [o.organization_id, o.practitioner_id, o.location_id, o.id, userId, start, end, expires], tx);
    await guardConflict(o, start, () => insertOccupancy(tx, o, start, 'hold', hold!.id, expires)); // 409 + alternativas; a transação inteira é revertida
    return { status: 201, body: { holdId: hold!.id, expiresAt: expires.toISOString(), startsAt: start.toISOString() } };
  }));
}

export async function releaseHold(userId: string, holdId: string) {
  await withTx(async (tx) => {
    const h = await one('SELECT id FROM slot_holds WHERE id=$1 AND user_id=$2 AND status=\'active\' FOR UPDATE', [holdId, userId], tx);
    if (!h) return;
    await tx.query("DELETE FROM practitioner_occupancies WHERE ref_id=$1 AND kind='hold'", [holdId]);
    await tx.query("UPDATE slot_holds SET status='released' WHERE id=$1", [holdId]);
  });
}

// ---------------------------------------------------------------------------
// Confirmação (paciente pelo app)
// ---------------------------------------------------------------------------
export const bookSchema = z.object({
  holdId: z.string().uuid().optional(),
  offeringId: z.string().uuid().optional(),
  startsAt: z.string().datetime().optional(),
  payerType: z.enum(['private', 'insurance']).default('private'),
  insuranceProductId: z.string().uuid().optional(),
  expectedPriceCents: z.number().int().nullable().optional(), // preço exibido ao paciente; divergência bloqueia
}).refine((v) => v.holdId || (v.offeringId && v.startsAt), 'Informe holdId ou offeringId+startsAt');

async function buildSnapshot(tx: Db, o: Offering, payer: { type: 'private' | 'insurance'; productId?: string }) {
  const r = await one<any>(
    `SELECT ps.price_cents, ps.currency, ps.duration_minutes, ps.conditions, ps.return_policy, ps.payment_methods,
            s.name AS service_name, l.name AS location_name, l.street, l.number, l.complement, l.neighborhood, l.city, l.uf, l.timezone,
            v.data AS ident, v.version AS ident_version, org.name AS org_name
       FROM practitioner_services ps JOIN services s ON s.id=ps.service_id JOIN locations l ON l.id=ps.location_id
       JOIN practitioners p ON p.id=ps.practitioner_id JOIN public_profile_versions v ON v.id=p.current_public_version_id
       JOIN organizations org ON org.id=ps.organization_id
      WHERE ps.id=$1`, [o.id], tx);
  let insurance: any = null;
  if (payer.type === 'insurance') {
    insurance = await one<any>(
      `SELECT ip.name AS product, i.name AS insurer, a.requires_authorization
         FROM accepted_insurance_products a JOIN insurance_products ip ON ip.id=a.insurance_product_id JOIN insurers i ON i.id=ip.insurer_id
        WHERE a.practitioner_service_id=$1 AND a.insurance_product_id=$2`, [o.id, payer.productId], tx);
    if (!insurance) throw badRequest('insurance_not_accepted', 'Convênio/produto não aceito para este serviço e local');
  } else {
    const acc = await one<{ accepts_private: boolean }>('SELECT accepts_private FROM practitioner_services WHERE id=$1', [o.id], tx);
    if (!acc?.accepts_private) throw badRequest('private_not_accepted', 'Este serviço não é oferecido como particular');
  }
  const terms = await currentVersion('termos-paciente', tx as any);
  const cancel = await currentVersion('politica-cancelamentos', tx as any).catch(() => null);
  const reg = r.ident.registrations?.[0];
  return {
    snapshot: {
      service: r.service_name, durationMinutes: r.duration_minutes,
      priceCents: payer.type === 'private' ? r.price_cents : null, priceInformed: payer.type === 'private' ? r.price_cents != null : false, currency: r.currency,
      payer: payer.type, insurance: insurance ? { product: insurance.product, insurer: insurance.insurer, requiresAuthorization: insurance.requires_authorization } : null,
      conditions: r.conditions, returnPolicy: r.return_policy, paymentMethods: r.payment_methods, paymentAt: 'no local',
      practitioner: { displayName: r.ident.display_name, registration: reg ? `CRM/${reg.uf} ${reg.number}` : null, specialties: r.ident.specialties.map((s: any) => s.name), profileVersion: r.ident_version },
      organization: r.org_name,
      location: { name: r.location_name, address: `${r.street}${r.number ? ', ' + r.number : ''}${r.complement ? ' - ' + r.complement : ''} — ${r.neighborhood}, ${r.city}/${r.uf}`, timezone: r.timezone },
      documents: { terms: { id: terms.id, version: terms.version, hash: terms.content_hash }, cancellation: cancel ? { id: cancel.id, version: cancel.version, hash: cancel.content_hash } : null },
    },
    requiresAuthorization: !!insurance?.requires_authorization,
    currentPriceCents: r.price_cents as number | null,
  };
}

async function ensureOrgPatientForAccount(tx: Db, userId: string, orgId: string): Promise<string> {
  const acc = await requirePatientAccount(userId, tx);
  const ex = await one<{ id: string }>(
    `SELECT op.id FROM organization_patients op JOIN patient_account_links l ON l.organization_patient_id = op.id
      WHERE op.organization_id=$1 AND l.patient_account_id=$2`, [orgId, acc.id], tx);
  if (ex) return ex.id;
  const u = await one<any>('SELECT full_name, phone, email FROM users WHERE id=$1', [userId], tx);
  const op = await one<{ id: string }>(
    `INSERT INTO organization_patients(organization_id, full_name, phone, email, created_via, created_by) VALUES ($1,$2,$3,$4,'app',$5) RETURNING id`,
    [orgId, u.full_name, u.phone, u.email, userId], tx);
  await tx.query(`INSERT INTO patient_account_links(organization_patient_id, patient_account_id, verified_at, verification_method) VALUES ($1,$2,now(),'self_booking')`, [op!.id, acc.id]);
  return op!.id;
}

interface CreateInput {
  o: Offering; start: Date; orgPatientId: string; requestedBy: string | null; source: 'app' | 'phone' | 'whatsapp' | 'reception';
  payer: { type: 'private' | 'insurance'; productId?: string }; expectedPriceCents?: number | null | undefined;
  holdOccupancyId?: string; holdId?: string; rescheduledFrom?: string; snapshotOverride?: any; actor: string | null;
}

async function createAppointmentRow(tx: Db, c: CreateInput) {
  const snap = await buildSnapshot(tx, c.o, c.payer);
  if (c.expectedPriceCents !== undefined && c.payer.type === 'private' && snap.currentPriceCents !== c.expectedPriceCents) {
    throw conflict('price_changed', 'O valor deste serviço foi alterado. Revise antes de confirmar.', { currentPriceCents: snap.currentPriceCents });
  }
  const end = new Date(c.start.getTime() + c.o.duration_minutes * 60_000);
  const status = snap.requiresAuthorization ? 'pending_approval' : 'scheduled';
  const id = (await one<{ id: string }>('SELECT gen_random_uuid() id', [], tx))!.id;
  let occId = c.holdOccupancyId;
  if (occId) {
    await tx.query(`UPDATE practitioner_occupancies SET kind='appointment', expires_at=NULL, ref_id=$2 WHERE id=$1`, [occId, id]);
  } else {
    occId = await guardConflict(c.o, c.start, () => insertOccupancy(tx, c.o, c.start, 'appointment', id, null));
  }
  await tx.query(
    `INSERT INTO appointments(id, organization_id, practitioner_id, location_id, practitioner_service_id, organization_patient_id, requested_by_user_id,
        starts_at, ends_at, timezone, source, status, payer_type, insurance_product_id, snapshot, hold_id, occupancy_id, rescheduled_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, c.o.organization_id, c.o.practitioner_id, c.o.location_id, c.o.id, c.orgPatientId, c.requestedBy, c.start, end, c.o.timezone, c.source, status,
     c.payer.type, c.payer.productId ?? null, JSON.stringify(c.snapshotOverride ?? snap.snapshot), c.holdId ?? null, occId, c.rescheduledFrom ?? null]);
  await tx.query(`INSERT INTO appointment_events(appointment_id, organization_id, type, to_status, to_attendance, actor_user_id, version) VALUES ($1,$2,'created',$3,'unconfirmed',$4,1)`,
    [id, c.o.organization_id, status, c.actor]);
  return { id, status, startsAt: c.start.toISOString(), endsAt: end.toISOString() };
}

async function emit(tx: Db, type: string, payload: Record<string, unknown>, dedupe: string) {
  await tx.query('INSERT INTO outbox_events(event_type, payload, dedupe_key) VALUES ($1,$2,$3) ON CONFLICT (dedupe_key) DO NOTHING', [type, JSON.stringify(payload), dedupe]);
}

/** Confirmação pelo paciente. Revalida horário/local/preço na transação; sem `holdId` ocupa direto (AC01). */
export async function bookAppointment(userId: string, raw: z.input<typeof bookSchema>, idemKey?: string): Promise<IdemResult<any>> {
  const b = bookSchema.parse(raw);
  return withAlternatives(() => idempotent(userId, 'book', idemKey, b, async (tx) => {
    let o: Offering | undefined; let start: Date; let holdOcc: string | undefined; let holdId: string | undefined;
    if (b.holdId) {
      const h = await one<any>(`SELECT * FROM slot_holds WHERE id=$1 FOR UPDATE`, [b.holdId], tx);
      if (!h || h.user_id !== userId) throw notFound('hold_not_found');
      if (h.status !== 'active' || new Date(h.expires_at) <= new Date()) {
        throw conflict('hold_expired', 'A reserva do horário expirou. Escolha um horário novamente.', { alternatives: await alternatives((await loadOffering(h.practitioner_service_id, tx))!, new Date(h.starts_at), tx) });
      }
      o = await loadOffering(h.practitioner_service_id, tx);
      start = new Date(h.starts_at);
      const occ = await one<{ id: string }>(`SELECT id FROM practitioner_occupancies WHERE ref_id=$1 AND kind='hold' AND expires_at > now() FOR UPDATE`, [h.id], tx);
      if (!occ) throw conflict('hold_expired', 'A reserva do horário expirou. Escolha um horário novamente.');
      holdOcc = occ.id; holdId = h.id;
    } else {
      o = await loadOffering(b.offeringId!, tx); start = new Date(b.startsAt!);
    }
    if (!o) throw notFound('offering_not_found');
    await assertBookable(tx, o.id);
    if (!(await isOffered(o, start, { ignoreOccupancy: true }, tx))) throw conflict('slot_not_offered', 'Horário não oferecido', { alternatives: await alternatives(o, start, tx) });
    if (!holdId) await purgeExpiredHolds(tx, o.practitioner_id);
    const orgPatientId = await ensureOrgPatientForAccount(tx, userId, o.organization_id);
    const appt = await createAppointmentRow(tx, {
      o, start, orgPatientId, requestedBy: userId, source: 'app', actor: userId,
      payer: { type: b.payerType, productId: b.insuranceProductId }, expectedPriceCents: b.expectedPriceCents,
      holdOccupancyId: holdOcc, holdId,
    });
    if (holdId) await tx.query("UPDATE slot_holds SET status='consumed', appointment_id=$2 WHERE id=$1", [holdId, appt.id]);
    await emit(tx, 'AppointmentScheduled', { appointmentId: appt.id, version: 1 }, `sched:${appt.id}:1`);
    await audit({ actorUserId: userId, organizationId: o.organization_id, action: 'appointment.created', objectType: 'appointment', objectId: appt.id, metadata: { source: 'app' } }, tx);
    return { status: 201, body: appt };
  }));
}

// ---------------------------------------------------------------------------
// Cadastro manual pela recepção (telefone / WhatsApp / recepção)
// ---------------------------------------------------------------------------
export const manualSchema = z.object({
  offeringId: z.string().uuid(), startsAt: z.string().datetime(),
  source: z.enum(['phone', 'whatsapp', 'reception']),
  patient: z.object({ fullName: z.string().trim().min(2).max(120), phone: z.string().max(30).optional(), email: z.string().email().optional(), organizationPatientId: z.string().uuid().optional() }),
  payerType: z.enum(['private', 'insurance']).default('private'), insuranceProductId: z.string().uuid().optional(),
});

/** Registro restrito à organização; NÃO cria senha nem aceite em nome do paciente; NÃO funde contas. */
export async function createManualAppointment(actor: string, org: string, raw: z.input<typeof manualSchema>) {
  const b = manualSchema.parse(raw);
  const g = await authorizeOrg(actor, org, 'appointment.create');
  return withAlternatives(() => withTx(async (tx) => {
    const o = await loadOffering(b.offeringId, tx);
    if (!o || o.organization_id !== org) throw notFound('offering_not_found');
    if (!g.allows(o.practitioner_id, o.location_id)) throw forbidden();
    await assertBookable(tx, o.id);
    const start = new Date(b.startsAt);
    if (!(await isOffered(o, start, { ignoreOccupancy: true }, tx))) throw conflict('slot_not_offered', 'Horário não oferecido', { alternatives: await alternatives(o, start, tx) });
    await purgeExpiredHolds(tx, o.practitioner_id);
    let opId = b.patient.organizationPatientId;
    if (opId) {
      const ok = await one('SELECT 1 FROM organization_patients WHERE id=$1 AND organization_id=$2', [opId, org], tx);
      if (!ok) throw notFound('patient_not_found');
    } else {
      opId = (await one<{ id: string }>(
        `INSERT INTO organization_patients(organization_id, full_name, phone, email, created_via, created_by) VALUES ($1,$2,$3,$4,'reception',$5) RETURNING id`,
        [org, b.patient.fullName, b.patient.phone ?? null, b.patient.email ?? null, actor], tx))!.id;
    }
    const appt = await createAppointmentRow(tx, { o, start, orgPatientId: opId, requestedBy: null, source: b.source, actor, payer: { type: b.payerType, productId: b.insuranceProductId } });
    await audit({ actorUserId: actor, organizationId: org, action: 'appointment.created', objectType: 'appointment', objectId: appt.id, metadata: { source: b.source } }, tx);
    return { ...appt, organizationPatientId: opId };
  }));
}

// ---------------------------------------------------------------------------
// Acesso a um agendamento (paciente-dono ou equipe autorizada)
// ---------------------------------------------------------------------------
type Actor = { kind: 'patient'; userId: string } | { kind: 'staff'; userId: string } | { kind: 'link'; purpose: string };

async function loadForUpdate(tx: PoolClient, id: string) {
  const a = await one<any>('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [id], tx);
  if (!a) throw notFound('appointment_not_found');
  return a;
}

async function isOwnerPatient(db: Db, userId: string, a: any) {
  if (a.requested_by_user_id === userId) return true;
  const r = await one(
    `SELECT 1 FROM patient_account_links l JOIN patient_accounts pa ON pa.id = l.patient_account_id
      WHERE l.organization_patient_id=$1 AND pa.user_id=$2`, [a.organization_patient_id, userId], db);
  return !!r;
}

/** Resolve o papel do ator sobre o agendamento. Sempre no servidor; IDs vindos do cliente nunca dão acesso por si. */
async function resolveActor(db: Db, userId: string, a: any, staffPermission: string): Promise<Actor> {
  if (await isOwnerPatient(db, userId, a)) return { kind: 'patient', userId };
  try {
    const g = await authorizeOrg(userId, a.organization_id, staffPermission, db);
    if (g.allows(a.practitioner_id, a.location_id)) return { kind: 'staff', userId };
  } catch { /* cai no not found para não revelar existência */ }
  throw notFound('appointment_not_found');
}

async function logTransition(tx: Db, a: any, type: string, actor: Actor, patch: { toStatus?: string; toAttendance?: string; reason?: string }, version: number) {
  await tx.query(
    `INSERT INTO appointment_events(appointment_id, organization_id, type, from_status, to_status, from_attendance, to_attendance, actor_user_id, actor_kind, reason, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [a.id, a.organization_id, type, a.status, patch.toStatus ?? a.status, a.attendance, patch.toAttendance ?? a.attendance,
     actor.kind === 'link' ? null : actor.userId, actor.kind === 'link' ? 'link' : 'user', patch.reason ?? null, version]);
}

const ACTIVE = ['scheduled', 'pending_approval'];

// ---------------------------------------------------------------------------
// Cancelamento (idempotente)
// ---------------------------------------------------------------------------
export async function cancelAppointment(userId: string | null, id: string, reason?: string, viaLink = false) {
  return withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    const actor: Actor = viaLink ? { kind: 'link', purpose: 'appt_cancel' } : await resolveActor(tx, userId!, a, 'appointment.update');
    if (a.status === 'cancelled') return { id, status: 'cancelled', alreadyCancelled: true }; // sem novos eventos nem estornos
    if (!ACTIVE.includes(a.status)) throw conflict('not_cancellable', 'Este agendamento não pode ser cancelado');
    if (new Date(a.starts_at) <= new Date()) throw conflict('already_started', 'O horário já começou');
    const version = a.version + 1;
    await tx.query(`UPDATE appointments SET status='cancelled', occupancy_id=NULL, cancelled_by=$2, cancel_reason=$3, cancelled_at=now(), version=$4, updated_at=now() WHERE id=$1`,
      [id, actor.kind === 'link' ? null : actor.userId, reason ?? null, version]);
    await tx.query('DELETE FROM practitioner_occupancies WHERE id=$1', [a.occupancy_id]);
    await logTransition(tx, a, 'cancelled', actor, { toStatus: 'cancelled', reason }, version);
    await emit(tx, 'AppointmentCancelled', { appointmentId: id, byStaff: actor.kind === 'staff' }, `cancel:${id}`);
    await audit({ actorUserId: actor.kind === 'link' ? null : actor.userId, actorKind: actor.kind === 'link' ? 'system' : 'user', organizationId: a.organization_id, action: 'appointment.cancelled', objectType: 'appointment', objectId: id, reason }, tx);
    return { id, status: 'cancelled', alreadyCancelled: false };
  });
}

// ---------------------------------------------------------------------------
// Reagendamento (atômico: falha no destino preserva a consulta original — AC08)
// ---------------------------------------------------------------------------
export async function rescheduleAppointment(userId: string, id: string, raw: { startsAt: string; offeringId?: string }, idemKey?: string) {
  const b = z.object({ startsAt: z.string().datetime(), offeringId: z.string().uuid().optional() }).parse(raw);
  return withAlternatives(() => idempotent(userId, `reschedule:${id}`, idemKey, b, async (tx) => {
    const old = await loadForUpdate(tx, id);
    const actor = await resolveActor(tx, userId, old, 'appointment.update');
    if (!ACTIVE.includes(old.status)) throw conflict('not_reschedulable', 'Este agendamento não pode ser reagendado');
    if (new Date(old.starts_at) <= new Date()) throw conflict('already_started', 'O horário já começou');
    const o = await loadOffering(b.offeringId ?? old.practitioner_service_id, tx);
    if (!o || o.organization_id !== old.organization_id || o.practitioner_id !== old.practitioner_id) throw badRequest('invalid_offering');
    const start = new Date(b.startsAt);
    await assertBookable(tx, o.id);
    if (!(await isOffered(o, start, { ignoreOccupancy: true }, tx))) throw conflict('slot_not_offered', 'Horário não oferecido', { alternatives: await alternatives(o, start, tx) });
    await purgeExpiredHolds(tx, o.practitioner_id);
    const oldOcc = old.occupancy_id;
    const version = old.version + 1;
    await tx.query(`UPDATE appointments SET status='rescheduled', occupancy_id=NULL, version=$2, updated_at=now() WHERE id=$1`, [id, version]);
    await tx.query('DELETE FROM practitioner_occupancies WHERE id=$1', [oldOcc]);
    // Preserva as condições comerciais contratadas (snapshot) quando o serviço é o mesmo.
    const keepSnapshot = o.id === old.practitioner_service_id ? { ...old.snapshot } : undefined;
    const appt = await createAppointmentRow(tx, {
      o, start, orgPatientId: old.organization_patient_id, requestedBy: old.requested_by_user_id, source: old.source, actor: userId,
      payer: { type: old.payer_type, productId: old.insurance_product_id ?? undefined }, rescheduledFrom: id, snapshotOverride: keepSnapshot,
    });
    await logTransition(tx, old, 'rescheduled', actor, { toStatus: 'rescheduled' }, version);
    await emit(tx, 'AppointmentRescheduled', { appointmentId: appt.id, previousAppointmentId: id }, `resched:${id}->${appt.id}`);
    await audit({ actorUserId: userId, organizationId: old.organization_id, action: 'appointment.rescheduled', objectType: 'appointment', objectId: appt.id, metadata: { from: id } }, tx);
    return { status: 200, body: appt };
  }));
}

// ---------------------------------------------------------------------------
// Presença / conclusão / falta
// ---------------------------------------------------------------------------
export async function confirmAttendance(userId: string | null, id: string, viaLink = false) {
  return withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    const actor: Actor = viaLink ? { kind: 'link', purpose: 'appt_confirm' } : await resolveActor(tx, userId!, a, 'appointment.update');
    if (a.status !== 'scheduled') throw conflict('not_confirmable', 'Agendamento não está ativo');
    if (a.attendance === 'confirmed') return { id, attendance: 'confirmed' };
    if (a.attendance !== 'unconfirmed') throw conflict('invalid_transition');
    if (new Date(a.starts_at) <= new Date()) throw conflict('already_started');
    const version = a.version + 1;
    await tx.query(`UPDATE appointments SET attendance='confirmed', version=$2, updated_at=now() WHERE id=$1`, [id, version]);
    await logTransition(tx, a, 'attendance_confirmed', actor, { toAttendance: 'confirmed' }, version);
    await emit(tx, 'AttendanceConfirmed', { appointmentId: id }, `attend:${id}`);
    return { id, attendance: 'confirmed' };
  });
}

async function staffOnly(tx: Db, userId: string, a: any, perm: string) {
  const g = await authorizeOrg(userId, a.organization_id, perm, tx);
  if (!g.allows(a.practitioner_id, a.location_id)) throw notFound('appointment_not_found');
}

export async function checkIn(userId: string, id: string) {
  return withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    await staffOnly(tx, userId, a, 'appointment.update');
    if (a.status !== 'scheduled' || !['unconfirmed', 'confirmed'].includes(a.attendance)) throw conflict('invalid_transition');
    const version = a.version + 1;
    await tx.query(`UPDATE appointments SET attendance='checked_in', version=$2, updated_at=now() WHERE id=$1`, [id, version]);
    await logTransition(tx, a, 'checked_in', { kind: 'staff', userId }, { toAttendance: 'checked_in' }, version);
    return { id, attendance: 'checked_in' };
  });
}

/** Conclusão/falta: somente equipe autorizada, após o horário de início. Registro administrativo. */
export async function closeAppointment(userId: string, id: string, outcome: 'completed' | 'no_show', reason?: string) {
  return withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    await staffOnly(tx, userId, a, 'appointment.close');
    if (a.status !== 'scheduled') throw conflict('invalid_transition', 'Agendamento não está ativo');
    if (new Date(a.starts_at) > new Date()) throw conflict('too_early', 'Só é possível registrar após o horário da consulta');
    const allowedFrom = outcome === 'completed' ? ['unconfirmed', 'confirmed', 'checked_in'] : ['unconfirmed', 'confirmed'];
    if (!allowedFrom.includes(a.attendance)) throw conflict('invalid_transition');
    const version = a.version + 1;
    await tx.query(`UPDATE appointments SET attendance=$2, version=$3, updated_at=now() WHERE id=$1`, [id, outcome, version]);
    await logTransition(tx, a, outcome, { kind: 'staff', userId }, { toAttendance: outcome, reason }, version);
    await audit({ actorUserId: userId, organizationId: a.organization_id, action: `appointment.${outcome}`, objectType: 'appointment', objectId: id, reason }, tx);
    return { id, attendance: outcome };
  });
}

export async function contestNoShow(userId: string, id: string, message: string) {
  return withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    if (!(await isOwnerPatient(tx, userId, a))) throw notFound('appointment_not_found');
    if (a.attendance !== 'no_show') throw conflict('not_no_show');
    const protocol = 'CT-' + Date.now().toString(36).toUpperCase();
    await tx.query(`INSERT INTO support_tickets(protocol, user_id, organization_id, subject, body) VALUES ($1,$2,$3,'Contestação de falta registrada',$4)`,
      [protocol, userId, a.organization_id, message.slice(0, 1000)]);
    await logTransition(tx, a, 'no_show_contested', { kind: 'patient', userId }, {}, a.version);
    return { protocol };
  });
}

/** Aprovação de solicitações pendentes (convênio que exige autorização). */
export async function approvePending(userId: string, id: string, approve: boolean, reason?: string) {
  return withTx(async (tx) => {
    const a = await loadForUpdate(tx, id);
    await staffOnly(tx, userId, a, 'appointment.update');
    if (a.status !== 'pending_approval') throw conflict('invalid_transition');
    const version = a.version + 1;
    if (approve) {
      await tx.query(`UPDATE appointments SET status='scheduled', version=$2, updated_at=now() WHERE id=$1`, [id, version]);
      await logTransition(tx, a, 'approved', { kind: 'staff', userId }, { toStatus: 'scheduled' }, version);
      await emit(tx, 'AppointmentScheduled', { appointmentId: id, version }, `sched:${id}:${version}`);
    } else {
      await tx.query(`UPDATE appointments SET status='cancelled', occupancy_id=NULL, cancelled_by=$2, cancel_reason=$3, cancelled_at=now(), version=$4, updated_at=now() WHERE id=$1`, [id, userId, reason ?? 'Autorização não concedida', version]);
      await tx.query('DELETE FROM practitioner_occupancies WHERE id=$1', [a.occupancy_id]);
      await logTransition(tx, a, 'denied', { kind: 'staff', userId }, { toStatus: 'cancelled', reason }, version);
      await emit(tx, 'AppointmentCancelled', { appointmentId: id, byStaff: true }, `cancel:${id}`);
    }
    return { id, status: approve ? 'scheduled' : 'cancelled' };
  });
}

// ---------------------------------------------------------------------------
// Consultas de leitura
// ---------------------------------------------------------------------------
const PATIENT_VIEW = `a.id, a.starts_at, a.ends_at, a.timezone, a.status, a.attendance, a.payer_type, a.snapshot, a.source, a.rescheduled_from, a.needs_followup, a.followup_reason`;

export async function listMyAppointments(userId: string) {
  return query(
    `SELECT ${PATIENT_VIEW} FROM appointments a
      WHERE a.requested_by_user_id=$1 OR a.organization_patient_id IN
        (SELECT l.organization_patient_id FROM patient_account_links l JOIN patient_accounts pa ON pa.id=l.patient_account_id WHERE pa.user_id=$1)
      ORDER BY a.starts_at DESC LIMIT 200`, [userId]);
}
export async function getMyAppointment(userId: string, id: string) {
  const a = await one<any>(`SELECT ${PATIENT_VIEW}, a.organization_id, a.organization_patient_id, a.requested_by_user_id FROM appointments a WHERE a.id=$1`, [id]);
  if (!a || !(await isOwnerPatient(pool(), userId, a))) throw notFound('appointment_not_found');
  const { organization_id: _o, organization_patient_id: _p, requested_by_user_id: _r, ...view } = a;
  const events = await query('SELECT type, to_status, to_attendance, at FROM appointment_events WHERE appointment_id=$1 ORDER BY id', [id]);
  return { ...view, events };
}

export async function listOrgAppointments(actor: string, org: string, from: string, to: string, opts: { practitionerId?: string } = {}) {
  const g = await authorizeOrg(actor, org, 'appointment.read');
  const params: unknown[] = [org, from, to];
  let extra = '';
  if (opts.practitionerId) { params.push(opts.practitionerId); extra = ` AND a.practitioner_id=$${params.length}`; }
  const scope = g.sql('a', params);
  return query(
    `SELECT a.id, a.practitioner_id, a.location_id, a.starts_at, a.ends_at, a.timezone, a.status, a.attendance, a.source, a.payer_type, a.needs_followup, a.followup_reason,
            a.snapshot->>'service' AS service, op.full_name AS patient_name, op.id AS organization_patient_id
       FROM appointments a JOIN organization_patients op ON op.id = a.organization_patient_id
      WHERE a.organization_id=$1 AND a.starts_at >= $2 AND a.starts_at < $3 AND ${scope}${extra}
      ORDER BY a.starts_at`, params);
}

export async function sweepExpiredHolds() {
  const r = await query<{ n: string }>(`WITH d AS (DELETE FROM practitioner_occupancies WHERE kind='hold' AND expires_at <= now() RETURNING 1) SELECT count(*) n FROM d`);
  await query(`UPDATE slot_holds SET status='expired' WHERE status='active' AND expires_at <= now()`);
  return Number(r[0].n);
}
export type { Grant };
