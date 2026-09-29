import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTx, one } from '../db';
import { AppError } from './errors';

export interface IdemResult<T> { status: number; body: T }

/**
 * Executa `fn` uma única vez por (usuário, operação, chave). Repetições com a mesma chave devolvem a resposta
 * gravada; mesma chave com corpo diferente é erro. Um lock advisory serializa chaves iguais concorrentes.
 */
export async function idempotent<T>(
  userId: string, operation: string, key: string | undefined, payload: unknown,
  fn: (tx: PoolClient) => Promise<IdemResult<T>>,
): Promise<IdemResult<T>> {
  if (!key) return withTx(fn);
  if (key.length > 100) throw new AppError(400, 'invalid_idempotency_key');
  const hash = createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
  return withTx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${userId}:${operation}:${key}`]);
    const prev = await one<{ request_hash: string; response_status: number; response_body: T }>(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id=$1 AND operation=$2 AND key=$3', [userId, operation, key], tx);
    if (prev) {
      if (prev.request_hash !== hash) throw new AppError(422, 'idempotency_key_reuse', 'Chave de idempotência já usada com outro conteúdo');
      return { status: prev.response_status, body: prev.response_body };
    }
    const res = await fn(tx);
    await tx.query(
      'INSERT INTO idempotency_keys(user_id, operation, key, request_hash, response_status, response_body) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, operation, key, hash, res.status, JSON.stringify(res.body)]);
    return res;
  });
}
