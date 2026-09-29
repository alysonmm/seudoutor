import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { one, query, withTx } from '../db';
import { audit } from '../lib/audit';
import { AppError, forbidden, notFound } from '../lib/errors';
import { setting } from '../lib/settings';
import { authorizeOrg, requirePlatform } from './authz';
import { windowsFor, at, type Rule, type Exc } from './availability';

/**
 * Dicionário de métricas (docs/architecture.md §Métricas):
 *  ocupação = minutos agendados / minutos disponibilizados (descontados bloqueios)
 *  falta    = no_show / (completed + no_show)  — consultas futuras não entram
 *  novo paciente = primeiro atendimento CONCLUÍDO daquele paciente na organização, dentro do período
 * Sempre informamos período e fuso.
 */
export async function orgMetrics(actor: string, org: string, fromDate: string, toDate: string) {
  const g = await authorizeOrg(actor, org, 'reports.read');
  const tz = (await one<{ timezone: string }>('SELECT timezone FROM locations WHERE organization_id=$1 ORDER BY created_at LIMIT 1', [org]))?.timezone ?? 'America/Sao_Paulo';
  const from = DateTime.fromISO(fromDate, { zone: tz }).startOf('day'), to = DateTime.fromISO(toDate, { zone: tz }).endOf('day');
  const params: unknown[] = [org, from.toJSDate(), to.toJSDate()];
  const scope = g.sql('a', params);
  const c = await one<any>(
    `SELECT count(*) FILTER (WHERE status IN ('scheduled','pending_approval') AND attendance NOT IN ('completed','no_show'))::int scheduled,
            count(*) FILTER (WHERE status='cancelled')::int cancelled,
            count(*) FILTER (WHERE status='scheduled' AND attendance='confirmed')::int confirmed,
            count(*) FILTER (WHERE attendance='completed')::int completed,
            count(*) FILTER (WHERE attendance='no_show')::int no_show,
            COALESCE(sum(extract(epoch FROM (ends_at - starts_at))/60) FILTER (WHERE status IN ('scheduled','pending_approval')),0)::float booked_minutes
       FROM appointments a WHERE a.organization_id=$1 AND a.starts_at >= $2 AND a.starts_at <= $3 AND ${scope}`, params);
  const denom = c.completed + c.no_show;
  // minutos disponibilizados por profissional/local dentro do escopo
  const pp: unknown[] = [org];
  const pairs = await query<{ practitioner_id: string; location_id: string }>(
    `SELECT DISTINCT r.practitioner_id, r.location_id FROM availability_rules r WHERE r.organization_id=$1 AND r.active AND ${g.sql('r', pp)}`, pp);
  let available = 0;
  const allowedPairs = pairs.filter((p) => g.allows(p.practitioner_id, p.location_id));
  for (const p of allowedPairs) {
    const rules = await query<Rule>(`SELECT weekday, start_time::text, end_time::text, slot_step_minutes, valid_from::text, valid_until::text FROM availability_rules WHERE organization_id=$1 AND practitioner_id=$2 AND location_id=$3 AND active`, [org, p.practitioner_id, p.location_id]);
    const excs = await query<Exc>(`SELECT on_date::text, kind, start_time::text, end_time::text FROM availability_exceptions WHERE organization_id=$1 AND practitioner_id=$2 AND location_id=$3 AND on_date BETWEEN $4 AND $5`, [org, p.practitioner_id, p.location_id, from.toISODate(), to.toISODate()]);
    const blocks = await query<{ s: Date; e: Date }>(`SELECT starts_at s, ends_at e FROM schedule_blocks WHERE organization_id=$1 AND practitioner_id=$2 AND (location_id IS NULL OR location_id=$3) AND starts_at < $5 AND ends_at > $4`, [org, p.practitioner_id, p.location_id, from.toJSDate(), to.toJSDate()]);
    for (let d = from; d <= to; d = d.plus({ days: 1 }).startOf('day')) {
      for (const w of windowsFor(d, rules, excs)) {
        const s = at(d, w.start), e = at(d, w.end);
        let mins = e.diff(s, 'minutes').minutes;
        for (const b of blocks) {
          const os = Math.max(s.toMillis(), b.s.getTime()), oe = Math.min(e.toMillis(), b.e.getTime());
          if (oe > os) mins -= (oe - os) / 60000;
        }
        available += Math.max(0, mins);
      }
    }
  }
  const p2: unknown[] = [org, from.toJSDate(), to.toJSDate()];
  const sc2 = g.sql('a', p2);
  const newPatients = await one<{ n: string }>(
    `SELECT count(*) n FROM (SELECT a.organization_patient_id, min(a.starts_at) f FROM appointments a WHERE a.organization_id=$1 AND a.attendance='completed' AND ${sc2} GROUP BY 1) t WHERE f >= $2 AND f <= $3`, p2);
  return {
    period: { from: from.toISODate(), to: to.toISODate(), timezone: tz },
    scheduled: c.scheduled, confirmed: c.confirmed, cancelled: c.cancelled, completed: c.completed, noShow: c.no_show,
    noShowRate: denom ? +(c.no_show / denom).toFixed(4) : null,
    occupancy: available > 0 ? +(c.booked_minutes / available).toFixed(4) : null,
    bookedMinutes: c.booked_minutes, availableMinutes: available,
    newPatients: Number(newPatients!.n),
  };
}

/** MRR: recorrência normalizada (anual/12); teste gratuito e valores transitórios não entram; consultas dos médicos não entram. */
export async function adminMetrics(actor: string) {
  await requirePlatform(actor, 'subscription.admin');
  const r = await one<any>(
    `SELECT COALESCE(sum(CASE billing_period WHEN 'yearly' THEN amount_cents / 12.0 ELSE amount_cents END),0)::float AS mrr_cents,
            count(*) FILTER (WHERE status='active')::int active, count(*) FILTER (WHERE status='trialing')::int trialing,
            count(*) FILTER (WHERE status IN ('grace_period','past_due'))::int delinquent
       FROM subscriptions WHERE status IN ('active','grace_period','past_due','cancel_at_period_end')`);
  const trialing = await one<any>("SELECT count(*)::int n FROM subscriptions WHERE status='trialing'");
  const orgs = await one<any>("SELECT count(*)::int n FROM organizations WHERE status='active'");
  const queue = await one<any>("SELECT count(*)::int n FROM public_profile_versions WHERE status='pending_review'");
  const tickets = await one<any>("SELECT count(*)::int n FROM support_tickets WHERE status='open'");
  const incidents = await one<any>("SELECT count(*)::int n FROM security_incidents WHERE status <> 'closed'");
  return { mrrCents: Math.round(r.mrr_cents), payingSubscriptions: r.active, delinquent: r.delinquent, trialing: trialing.n, activeOrganizations: orgs.n, credentialingQueue: queue.n, openTickets: tickets.n, openIncidents: incidents.n };
}

/** Agregado por especialidade com supressão de grupos pequenos. */
export async function adminSpecialtyDistribution(actor: string) {
  await requirePlatform(actor, 'subscription.admin');
  const min = await setting<number>('small_group_suppression_min', 5);
  const rows = await query<{ name: string; n: number }>(`SELECT s.name, count(DISTINCT ps.practitioner_id)::int n FROM practitioner_specialties ps JOIN specialties s ON s.id=ps.specialty_id JOIN practitioners p ON p.id=ps.practitioner_id WHERE p.status='approved' GROUP BY s.name ORDER BY s.name`);
  return rows.map((r) => (r.n < min ? { name: r.name, count: null, suppressed: true } : { name: r.name, count: r.n, suppressed: false }));
}

// ---------------------------------------------------------------------------
// Exportações: registro, limite, arquivo privado, expiração; acesso revalidado na execução (AC22)
// ---------------------------------------------------------------------------
const EXPORT_DIR = path.resolve(process.cwd(), 'storage/private/exports');
const MAX_ROWS = 5000;

export async function requestExport(actor: string, org: string, from: string, to: string) {
  await authorizeOrg(actor, org, 'export.general');
  const r = await one<{ id: string }>(
    `INSERT INTO data_exports(organization_id, requested_by, kind, params, expires_at) VALUES ($1,$2,'appointments_csv',$3, now() + interval '24 hours') RETURNING id`,
    [org, actor, JSON.stringify({ from, to })]);
  await audit({ actorUserId: actor, organizationId: org, action: 'export.requested', objectType: 'data_export', objectId: r!.id });
  return { id: r!.id };
}

const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`; // evita injeção de fórmula

export async function processExports() {
  const jobs = await query<any>("SELECT * FROM data_exports WHERE status='pending' ORDER BY created_at LIMIT 20");
  for (const j of jobs) {
    try {
      // revalida o acesso do solicitante NO MOMENTO da execução, com a organização fixada no pedido
      const g = await authorizeOrg(j.requested_by, j.organization_id, 'export.general');
      const params: unknown[] = [j.organization_id, j.params.from, j.params.to];
      const rows = await query<any>(
        `SELECT a.id, a.starts_at, a.status, a.attendance, a.source, a.snapshot->>'service' service, op.full_name FROM appointments a
           JOIN organization_patients op ON op.id=a.organization_patient_id
          WHERE a.organization_id=$1 AND a.starts_at >= $2 AND a.starts_at < $3 AND ${g.sql('a', params)} ORDER BY a.starts_at LIMIT ${MAX_ROWS}`, params);
      fs.mkdirSync(EXPORT_DIR, { recursive: true, mode: 0o700 });
      const file = path.join(EXPORT_DIR, `${j.id}.csv`);
      fs.writeFileSync(file, ['id,inicio_utc,status,presenca,origem,servico,paciente', ...rows.map((r) => [r.id, r.starts_at.toISOString(), r.status, r.attendance, r.source, r.service, r.full_name].map(csv).join(','))].join('\n'), { mode: 0o600 });
      await query("UPDATE data_exports SET status='ready', file_path=$2, row_count=$3, completed_at=now() WHERE id=$1", [j.id, file, rows.length]);
      await audit({ actorKind: 'system', organizationId: j.organization_id, action: 'export.generated', objectType: 'data_export', objectId: j.id, metadata: { rows: rows.length, requestedBy: j.requested_by } });
    } catch (e: any) {
      await query("UPDATE data_exports SET status='denied', denial_reason=$2, completed_at=now() WHERE id=$1", [j.id, String(e.code ?? e.message).slice(0, 100)]);
      await audit({ actorKind: 'system', organizationId: j.organization_id, action: 'export.denied', objectType: 'data_export', objectId: j.id });
    }
  }
  await query("UPDATE data_exports SET status='expired' WHERE status='ready' AND expires_at <= now()");
  return jobs.length;
}

export async function downloadExport(actor: string, org: string, id: string): Promise<string> {
  await authorizeOrg(actor, org, 'export.general');
  const j = await one<any>('SELECT * FROM data_exports WHERE id=$1 AND organization_id=$2', [id, org]);
  if (!j || j.requested_by !== actor) throw notFound();
  if (j.status !== 'ready') throw new AppError(409, 'export_not_ready');
  if (new Date(j.expires_at) < new Date()) throw new AppError(410, 'export_expired');
  await audit({ actorUserId: actor, organizationId: org, action: 'export.downloaded', objectType: 'data_export', objectId: id });
  return fs.readFileSync(j.file_path, 'utf8');
}
export { forbidden, withTx };
