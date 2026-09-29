import { one, query, pool, type Db } from '../db';
import { AppError, forbidden } from '../lib/errors';

/**
 * Feature flags com falha fechada. Uma flag regulada só vale se:
 *  enabled = true E implemented = true E existir aprovação registrada não vencida.
 * Erro de leitura => desligada.
 */
export async function isEnabled(key: string, db: Db = pool()): Promise<boolean> {
  try {
    const f = await one<{ enabled: boolean; regulated: boolean; implemented: boolean; review_by: string | null; approved_by: string | null }>(
      `SELECT f.enabled, f.regulated, f.implemented, a.review_by::text AS review_by, a.approved_by
         FROM feature_flags f LEFT JOIN feature_approvals a ON a.id = f.approval_id WHERE f.key = $1`, [key], db);
    if (!f || !f.enabled || !f.implemented) return false;
    if (f.regulated) {
      if (!f.approved_by || !f.review_by) return false;
      if (new Date(f.review_by + 'T23:59:59Z').getTime() < Date.now()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Guarda de servidor para rotas de módulos bloqueados (AC17). */
export async function requireFeature(key: string) {
  if (!(await isEnabled(key))) {
    throw new AppError(403, 'feature_disabled', 'Recurso indisponível: módulo não habilitado nesta plataforma');
  }
  // Mesmo habilitada em banco, não há implementação para executar neste MVP.
  throw new AppError(501, 'not_implemented', 'Recurso previsto, ainda não implementado');
}

export async function listFlags() {
  return query(`SELECT f.key, f.description, f.regulated, f.implemented, f.enabled, a.decision_ref, a.review_by
                  FROM feature_flags f LEFT JOIN feature_approvals a ON a.id = f.approval_id ORDER BY f.key`);
}

export async function approveAndEnableFlag(actorId: string, input: {
  key: string; decisionRef: string; scope: string; approvedBy: string; approvedAt: string; reviewBy: string;
}) {
  const f = await one('SELECT regulated, implemented FROM feature_flags WHERE key=$1', [input.key]);
  if (!f) throw new AppError(404, 'not_found');
  if (!f.implemented) throw forbidden('not_implemented', 'Não há implementação a habilitar para este recurso');
  const { withTx } = await import('../db');
  const { audit } = await import('../lib/audit');
  await withTx(async (tx) => {
    const a = await one<{ id: string }>(
      `INSERT INTO feature_approvals(feature_key, decision_ref, scope, approved_by, approved_at, review_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.key, input.decisionRef, input.scope, input.approvedBy, input.approvedAt, input.reviewBy, actorId], tx);
    await tx.query('UPDATE feature_flags SET enabled=true, approval_id=$2, updated_at=now() WHERE key=$1', [input.key, a!.id]);
    await audit({ actorUserId: actorId, action: 'feature.enabled', objectType: 'feature_flag', objectId: input.key,
      metadata: { decisionRef: input.decisionRef, reviewBy: input.reviewBy } }, tx);
  });
}
