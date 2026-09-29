import { one, pool, type Db } from '../db';
import { AppError } from '../lib/errors';

/**
 * Direito de uso (entitlement) derivado da assinatura. Decisão registrada em docs/legal-decisions.md:
 *  - trialing (dentro do prazo), active, grace_period (carência), cancel_at_period_end (até o fim do período): pleno
 *  - past_due/expired/cancelled/pending: SEM novas marcações públicas nem novos recursos; consultas existentes
 *    permanecem visíveis e operáveis; exportação autorizada continua disponível.
 */
export async function isOrgEntitled(organizationId: string, db: Db = pool()): Promise<boolean> {
  const s = await one<{ ok: boolean }>(
    `SELECT (CASE status
        WHEN 'trialing' THEN trial_ends_at > now()
        WHEN 'active' THEN true
        WHEN 'grace_period' THEN true
        WHEN 'cancel_at_period_end' THEN current_period_end > now()
        ELSE false END) AS ok
       FROM subscriptions WHERE organization_id=$1 AND status NOT IN ('cancelled','expired')`, [organizationId], db);
  return !!s?.ok;
}

export type LimitKind = 'practitioners' | 'locations' | 'members';
const FALLBACK_PLAN = 'essencial';

export async function getLimits(organizationId: string, db: Db = pool()): Promise<Record<string, number>> {
  const r = await one<{ limits: Record<string, number> }>(
    `SELECT pv.limits FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id
      WHERE s.organization_id=$1 AND s.status NOT IN ('cancelled','expired')`, [organizationId], db);
  if (r) return r.limits;
  const f = await one<{ limits: Record<string, number> }>(
    'SELECT limits FROM plan_versions WHERE plan_id=$1 ORDER BY version DESC LIMIT 1', [FALLBACK_PLAN], db);
  return f!.limits;
}

async function usage(organizationId: string, kind: LimitKind, db: Db): Promise<number> {
  const sql = {
    practitioners: "SELECT count(*)::int n FROM practitioner_memberships WHERE organization_id=$1 AND status='active'",
    locations: 'SELECT count(*)::int n FROM locations WHERE organization_id=$1 AND active',
    // cota de equipe conta secretárias/financeiro (gestores e médicos têm cota própria)
    members: "SELECT count(*)::int n FROM memberships WHERE organization_id=$1 AND status='active' AND role_id IN ('secretary','finance')",
  }[kind];
  return (await one<{ n: number }>(sql, [organizationId], db))!.n;
}

export async function assertWithinLimit(organizationId: string, kind: LimitKind, opts: { extra?: number } = {}, db: Db = pool()) {
  const limits = await getLimits(organizationId, db);
  const max = limits[kind];
  const used = await usage(organizationId, kind, db);
  if (max !== undefined && used + (opts.extra ?? 1) > max) {
    throw new AppError(409, 'plan_limit_reached', `Limite do plano atingido para ${kind} (${used}/${max}). Contrate um plano maior para continuar.`);
  }
}
