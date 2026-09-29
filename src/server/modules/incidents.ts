import { z } from 'zod';
import { DateTime } from 'luxon';
import { one, query } from '../db';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { requirePlatform } from './authz';

/** Soma N dias ÚTEIS (seg–sex). Feriados NÃO são considerados: revisar com o jurídico/encarregado. */
export function addBusinessDays(from: Date, n: number, tz = 'America/Sao_Paulo'): Date {
  let d = DateTime.fromJSDate(from, { zone: tz });
  let left = n;
  while (left > 0) { d = d.plus({ days: 1 }); if (d.weekday <= 5) left--; }
  return d.toJSDate();
}

export const incidentSchema = z.object({
  title: z.string().min(5).max(200), severity: z.enum(['low', 'medium', 'high', 'critical']),
  detectedAt: z.string().datetime(), awarenessAt: z.string().datetime(), affectsPersonalData: z.boolean(), owner: z.string().max(120).optional(),
});

/**
 * Relógio do prazo: referência J8 (3 dias úteis desde a ciência de afetação de dados pessoais, ressalvadas regras aplicáveis).
 * O prazo é apoio operacional; quem decide comunicar e quando é o responsável jurídico/privacidade.
 */
export async function createIncident(actor: string, raw: z.input<typeof incidentSchema>) {
  await requirePlatform(actor, 'incident.manage');
  const i = incidentSchema.parse(raw);
  const due = i.affectsPersonalData ? addBusinessDays(new Date(i.awarenessAt), 3) : null;
  const r = await one<{ id: string }>(
    `INSERT INTO security_incidents(title, severity, detected_at, awareness_at, affects_personal_data, communication_due_at, owner, created_by, timeline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [i.title, i.severity, i.detectedAt, i.awarenessAt, i.affectsPersonalData, due, i.owner ?? null, actor, JSON.stringify([{ at: new Date().toISOString(), event: 'identified' }])]);
  await audit({ actorUserId: actor, action: 'incident.created', objectType: 'security_incident', objectId: r!.id, metadata: { severity: i.severity } });
  return { id: r!.id, communicationDueAt: due };
}

const STEPS = ['identified', 'contained', 'assessing', 'communicated', 'closed'] as const;
export async function advanceIncident(actor: string, id: string, status: (typeof STEPS)[number], note?: string) {
  await requirePlatform(actor, 'incident.manage');
  const inc = await one<any>('SELECT * FROM security_incidents WHERE id=$1', [id]);
  if (!inc) throw notFound();
  const timeline = [...inc.timeline, { at: new Date().toISOString(), event: status, note: note?.slice(0, 300), by: actor }];
  await query(`UPDATE security_incidents SET status=$2, timeline=$3, closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END WHERE id=$1`, [id, status, JSON.stringify(timeline)]);
  await audit({ actorUserId: actor, action: 'incident.advanced', objectType: 'security_incident', objectId: id, metadata: { status } });
}

export async function listIncidents(actor: string) {
  await requirePlatform(actor, 'incident.manage');
  return query(`SELECT id, title, severity, status, detected_at, awareness_at, affects_personal_data, communication_due_at, (communication_due_at IS NOT NULL AND communication_due_at < now() AND status NOT IN ('communicated','closed')) AS overdue FROM security_incidents ORDER BY detected_at DESC`);
}

export async function listAudit(actor: string, filter: { action?: string; organizationId?: string; limit?: number } = {}) {
  await requirePlatform(actor, 'audit.read');
  const rows = await query(
    `SELECT id, at, actor_user_id, actor_kind, organization_id, action, object_type, object_id, reason FROM audit_events
      WHERE ($1::text IS NULL OR action = $1) AND ($2::uuid IS NULL OR organization_id = $2) ORDER BY id DESC LIMIT $3`,
    [filter.action ?? null, filter.organizationId ?? null, Math.min(filter.limit ?? 100, 500)]);
  await audit({ actorUserId: actor, action: 'audit.viewed', metadata: { filter: filter.action ?? null } });
  return rows;
}
