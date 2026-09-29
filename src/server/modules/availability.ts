import { DateTime } from 'luxon';
import { z } from 'zod';
import { one, query, withTx, pool, type Db } from '../db';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { setting } from '../lib/settings';
import { authorizeOrg } from './authz';

export interface Offering {
  id: string; organization_id: string; practitioner_id: string; location_id: string; service_id: string;
  duration_minutes: number; prep_minutes: number; buffer_minutes: number; timezone: string; travel: number;
}
export interface Slot { startsAt: string; endsAt: string; localDate: string; localTime: string }

export async function loadOffering(id: string, db: Db = pool()): Promise<Offering | undefined> {
  return one<Offering>(
    `SELECT ps.id, ps.organization_id, ps.practitioner_id, ps.location_id, ps.service_id, ps.duration_minutes,
            ps.prep_minutes, ps.buffer_minutes, l.timezone, p.travel_buffer_minutes AS travel
       FROM practitioner_services ps
       JOIN locations l ON l.id = ps.location_id AND l.organization_id = ps.organization_id
       JOIN practitioners p ON p.id = ps.practitioner_id
      WHERE ps.id=$1`, [id], db);
}

/** Intervalo de ocupação = consulta + preparo + intervalo posterior + deslocamento (conservador, dos dois lados). */
export function occupancyRange(o: Pick<Offering, 'duration_minutes' | 'prep_minutes' | 'buffer_minutes' | 'travel'>, start: Date) {
  const s = new Date(start.getTime() - (o.prep_minutes + o.travel) * 60_000);
  const e = new Date(start.getTime() + (o.duration_minutes + o.buffer_minutes + o.travel) * 60_000);
  return { lower: s, upper: e };
}

export interface Rule { weekday: number; start_time: string; end_time: string; slot_step_minutes: number; valid_from: string | null; valid_until: string | null }
export interface Exc { on_date: string; kind: 'closed' | 'open'; start_time: string | null; end_time: string | null }

/** Janelas de atendimento do dia local: exceções da data prevalecem sobre a recorrência. */
export function windowsFor(day: DateTime, rules: Rule[], excs: Exc[]): { start: string; end: string; step: number }[] {
  const iso = day.toISODate()!;
  const dayExcs = excs.filter((e) => e.on_date === iso);
  if (dayExcs.length) {
    return dayExcs.filter((e) => e.kind === 'open').map((e) => ({ start: e.start_time!, end: e.end_time!, step: 15 }));
  }
  return rules
    .filter((r) => r.weekday === day.weekday && (!r.valid_from || r.valid_from <= iso) && (!r.valid_until || r.valid_until >= iso))
    .map((r) => ({ start: r.start_time, end: r.end_time, step: r.slot_step_minutes }));
}

export const at = (day: DateTime, hhmmss: string) => {
  const [h, m] = hhmmss.split(':').map(Number);
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
};

export interface SlotOptions { ignoreOccupancy?: boolean; ignoreNoticeAndHorizon?: boolean; excludeAppointmentId?: string; now?: Date }

/** Calcula horários oferecidos entre duas datas locais (inclusive). Livre/ocupado global, sem revelar terceiros. */
export async function computeSlots(o: Offering, fromDate: string, toDate: string, opts: SlotOptions = {}, db: Db = pool()): Promise<Slot[]> {
  const now = opts.now ?? new Date();
  const minNotice = await setting<number>('booking_min_notice_minutes', 60, db);
  const horizon = await setting<number>('booking_horizon_days', 60, db);
  const first = DateTime.fromISO(fromDate, { zone: o.timezone }).startOf('day');
  const last = DateTime.fromISO(toDate, { zone: o.timezone }).endOf('day');
  if (!first.isValid || !last.isValid) throw badRequest('invalid_date');
  if (last.diff(first, 'days').days > 92) throw badRequest('range_too_large', 'Intervalo máximo de 92 dias');
  const rules = await query<Rule>(
    `SELECT weekday, start_time::text, end_time::text, slot_step_minutes, valid_from::text, valid_until::text
       FROM availability_rules WHERE practitioner_id=$1 AND location_id=$2 AND organization_id=$3 AND active`,
    [o.practitioner_id, o.location_id, o.organization_id], db);
  if (rules.length === 0 && !(await query('SELECT 1 FROM availability_exceptions WHERE practitioner_id=$1 AND location_id=$2 AND kind=$3 LIMIT 1', [o.practitioner_id, o.location_id, 'open'], db)).length) return [];
  const excs = await query<Exc>(
    `SELECT on_date::text, kind, start_time::text, end_time::text FROM availability_exceptions
      WHERE practitioner_id=$1 AND location_id=$2 AND organization_id=$3 AND on_date BETWEEN $4 AND $5`,
    [o.practitioner_id, o.location_id, o.organization_id, first.toISODate(), last.toISODate()], db);
  const from = first.toJSDate(), to = last.toJSDate();
  const blocks = await query<{ s: Date; e: Date }>(
    `SELECT starts_at s, ends_at e FROM schedule_blocks
      WHERE organization_id=$1 AND practitioner_id=$2 AND (location_id IS NULL OR location_id=$3) AND starts_at < $5 AND ends_at > $4`,
    [o.organization_id, o.practitioner_id, o.location_id, from, to], db);
  const occ = opts.ignoreOccupancy ? [] : await query<{ lo: Date; up: Date }>(
    `SELECT lower(during) lo, upper(during) up FROM practitioner_occupancies
      WHERE practitioner_id=$1 AND during && tstzrange($2,$3,'[)')
        AND (kind <> 'hold' OR expires_at > now())
        AND ($4::uuid IS NULL OR ref_id <> $4::uuid)`,
    [o.practitioner_id, new Date(from.getTime() - 86_400_000), new Date(to.getTime() + 86_400_000), opts.excludeAppointmentId ?? null], db);
  const earliest = opts.ignoreNoticeAndHorizon ? 0 : now.getTime() + minNotice * 60_000;
  const latest = opts.ignoreNoticeAndHorizon ? Infinity : now.getTime() + horizon * 86_400_000;
  const out: Slot[] = [];
  for (let day = first; day <= last; day = day.plus({ days: 1 }).startOf('day')) {
    for (const w of windowsFor(day, rules, excs)) {
      const wEnd = at(day, w.end);
      for (let t = at(day, w.start); t.plus({ minutes: o.duration_minutes }) <= wEnd; t = t.plus({ minutes: w.step })) {
        const start = t.toJSDate();
        if (start.getTime() < earliest || start.getTime() > latest) continue;
        const { lower, upper } = occupancyRange(o, start);
        const end = new Date(start.getTime() + o.duration_minutes * 60_000);
        if (blocks.some((b) => b.s < end && b.e > start)) continue;
        if (occ.some((x) => x.lo < upper && x.up > lower)) continue;
        out.push({ startsAt: start.toISOString(), endsAt: end.toISOString(), localDate: t.toISODate()!, localTime: t.toFormat('HH:mm') });
      }
    }
  }
  return out;
}

/** O horário pertence à grade oferecida (regras/exceções/bloqueios), independentemente de ocupação? Usado na reserva. */
export async function isOffered(o: Offering, start: Date, opts: SlotOptions = {}, db: Db = pool()): Promise<boolean> {
  const d = DateTime.fromJSDate(start, { zone: o.timezone }).toISODate()!;
  const slots = await computeSlots(o, d, d, opts, db);
  return slots.some((s) => s.startsAt === start.toISOString());
}

/** Próximo horário: busca em janelas crescentes (3, 7, 14 dias) para não calcular 14 dias quando há vaga próxima. */
export async function nextSlot(o: Offering, opts: { days?: number } = {}, db: Db = pool()): Promise<Slot | null> {
  const from = DateTime.now().setZone(o.timezone).toISODate()!;
  const max = opts.days ?? 14;
  for (const d of [3, 7, max].filter((x, i, a) => x <= max && a.indexOf(x) === i)) {
    const to = DateTime.now().setZone(o.timezone).plus({ days: d }).toISODate()!;
    const s = (await computeSlots(o, from, to, {}, db))[0];
    if (s) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gestão de regras, exceções e bloqueios (com tratamento explícito de impacto)
// ---------------------------------------------------------------------------
const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
export const ruleSchema = z.object({
  practitionerId: z.string().uuid(), locationId: z.string().uuid(),
  weekday: z.number().int().min(1).max(7), startTime: time, endTime: time,
  slotStepMinutes: z.number().int().min(5).max(240).default(15),
  validFrom: z.string().date().nullish(), validUntil: z.string().date().nullish(),
});

async function authorizeSchedule(actor: string, org: string, practitionerId: string, locationId?: string | null) {
  const g = await authorizeOrg(actor, org, 'schedule.manage');
  if (!g.allowsPractitioner(practitionerId)) throw forbidden();
  if (locationId && !g.allowsLocation(locationId)) throw forbidden();
  return g;
}

/** Agendamentos futuros ativos do par médico+local que deixaram de estar na grade. */
async function impactedAppointments(tx: Db, org: string, practitionerId: string, locationId: string): Promise<string[]> {
  const appts = await query<{ id: string; starts_at: Date; practitioner_service_id: string }>(
    `SELECT id, starts_at, practitioner_service_id FROM appointments
      WHERE organization_id=$1 AND practitioner_id=$2 AND location_id=$3 AND status IN ('scheduled','pending_approval') AND starts_at > now()`,
    [org, practitionerId, locationId], tx);
  const impacted: string[] = [];
  for (const a of appts) {
    const o = await loadOffering(a.practitioner_service_id, tx);
    if (!o) continue;
    if (!(await isOffered(o, a.starts_at, { ignoreOccupancy: true, ignoreNoticeAndHorizon: true }, tx))) impacted.push(a.id);
  }
  return impacted;
}

async function settleImpact(tx: Db, org: string, practitionerId: string, locationId: string, acknowledge: string[], reason: string) {
  const impacted = await impactedAppointments(tx, org, practitionerId, locationId);
  const missing = impacted.filter((id) => !acknowledge.includes(id));
  if (missing.length) {
    throw conflict('schedule_change_impacts_appointments',
      'A alteração afeta consultas já marcadas. Trate cada uma explicitamente (reagendar/cancelar) ou reconheça o impacto informando os IDs.',
      { impactedAppointmentIds: impacted });
  }
  // reconhecidas: preservadas, porém sinalizadas para contato com o paciente
  if (impacted.length) {
    await tx.query(`UPDATE appointments SET needs_followup=true, followup_reason=$2, updated_at=now() WHERE id = ANY($1::uuid[])`, [impacted, reason]);
  }
  return impacted;
}

export async function createRule(actor: string, org: string, raw: z.input<typeof ruleSchema>) {
  const r = ruleSchema.parse(raw);
  await authorizeSchedule(actor, org, r.practitionerId, r.locationId);
  if (r.startTime >= r.endTime) throw badRequest('invalid_window');
  const row = await one<{ id: string }>(
    `INSERT INTO availability_rules(organization_id, practitioner_id, location_id, weekday, start_time, end_time, slot_step_minutes, valid_from, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [org, r.practitionerId, r.locationId, r.weekday, r.startTime, r.endTime, r.slotStepMinutes, r.validFrom ?? null, r.validUntil ?? null]);
  await audit({ actorUserId: actor, organizationId: org, action: 'schedule.rule_created', objectType: 'availability_rule', objectId: row!.id });
  return { id: row!.id };
}

export async function deactivateRule(actor: string, org: string, ruleId: string, acknowledge: string[] = []) {
  const rule = await one<{ practitioner_id: string; location_id: string }>('SELECT practitioner_id, location_id FROM availability_rules WHERE id=$1 AND organization_id=$2', [ruleId, org]);
  if (!rule) throw notFound();
  await authorizeSchedule(actor, org, rule.practitioner_id, rule.location_id);
  return withTx(async (tx) => {
    await tx.query('UPDATE availability_rules SET active=false WHERE id=$1', [ruleId]);
    const impacted = await settleImpact(tx, org, rule.practitioner_id, rule.location_id, acknowledge, 'Regra de disponibilidade removida');
    await audit({ actorUserId: actor, organizationId: org, action: 'schedule.rule_deactivated', objectType: 'availability_rule', objectId: ruleId, metadata: { impacted: impacted.length } }, tx);
    return { impactedAppointmentIds: impacted };
  });
}

export const exceptionSchema = z.object({
  practitionerId: z.string().uuid(), locationId: z.string().uuid(), onDate: z.string().date(),
  kind: z.enum(['closed', 'open']), startTime: time.optional(), endTime: time.optional(), reason: z.string().max(200).optional(),
  acknowledgeImpactIds: z.array(z.string().uuid()).default([]),
});
export async function createException(actor: string, org: string, raw: z.input<typeof exceptionSchema>) {
  const x = exceptionSchema.parse(raw);
  await authorizeSchedule(actor, org, x.practitionerId, x.locationId);
  return withTx(async (tx) => {
    const row = await one<{ id: string }>(
      `INSERT INTO availability_exceptions(organization_id, practitioner_id, location_id, on_date, kind, start_time, end_time, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [org, x.practitionerId, x.locationId, x.onDate, x.kind, x.startTime ?? null, x.endTime ?? null, x.reason ?? null], tx);
    const impacted = await settleImpact(tx, org, x.practitionerId, x.locationId, x.acknowledgeImpactIds, 'Exceção de agenda criada');
    await audit({ actorUserId: actor, organizationId: org, action: 'schedule.exception_created', objectType: 'availability_exception', objectId: row!.id }, tx);
    return { id: row!.id, impactedAppointmentIds: impacted };
  });
}

export const blockSchema = z.object({
  practitionerId: z.string().uuid(), locationId: z.string().uuid().nullish(),
  startsAt: z.string().datetime(), endsAt: z.string().datetime(), reason: z.string().max(200).optional(),
});
/** Bloqueio sobre consultas existentes é recusado com a lista de impactadas: tratar cada uma antes. */
export async function createBlock(actor: string, org: string, raw: z.input<typeof blockSchema>) {
  const b = blockSchema.parse(raw);
  await authorizeSchedule(actor, org, b.practitionerId, b.locationId);
  if (new Date(b.startsAt) >= new Date(b.endsAt)) throw badRequest('invalid_window');
  return withTx(async (tx) => {
    const hit = await query<{ id: string }>(
      `SELECT id FROM appointments WHERE organization_id=$1 AND practitioner_id=$2 AND status IN ('scheduled','pending_approval')
          AND ($3::uuid IS NULL OR location_id=$3) AND starts_at < $5 AND ends_at > $4`,
      [org, b.practitionerId, b.locationId ?? null, b.startsAt, b.endsAt], tx);
    if (hit.length) throw conflict('block_impacts_appointments', 'Existem consultas no período. Reagende ou cancele cada uma antes de bloquear.', { impactedAppointmentIds: hit.map((h) => h.id) });
    const row = await one<{ id: string }>(
      `INSERT INTO schedule_blocks(organization_id, practitioner_id, location_id, starts_at, ends_at, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [org, b.practitionerId, b.locationId ?? null, b.startsAt, b.endsAt, b.reason ?? null, actor], tx);
    await audit({ actorUserId: actor, organizationId: org, action: 'schedule.block_created', objectType: 'schedule_block', objectId: row!.id }, tx);
    return { id: row!.id };
  });
}

export async function listRules(actor: string, org: string, practitionerId: string) {
  const g = await authorizeOrg(actor, org, 'schedule.read');
  if (!g.allowsPractitioner(practitionerId)) throw forbidden();
  return query(
    `SELECT id, location_id, weekday, start_time::text, end_time::text, slot_step_minutes, valid_from, valid_until, active
       FROM availability_rules WHERE organization_id=$1 AND practitioner_id=$2 AND active ORDER BY weekday, start_time`, [org, practitionerId]);
}

export { AppError };
