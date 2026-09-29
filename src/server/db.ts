import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from './config';

const g = globalThis as unknown as { __pool?: Pool };

export function pool(): Pool {
  if (!g.__pool) {
    g.__pool = new Pool({ connectionString: config.databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 20) });
    g.__pool.on('error', (e) => console.error('pg pool error', e.message));
  }
  return g.__pool;
}

export type Db = Pick<PoolClient, 'query'>;

export async function query<T extends QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool()) {
  return (await db.query<T>(text, params as any[])).rows;
}
export async function one<T extends QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool()) {
  const rows = await query<T>(text, params, db);
  return rows[0] as T | undefined;
}

/** Transação com nível READ COMMITTED (a correção de concorrência vem das constraints/locks). */
export async function withTx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignora */ }
    throw e;
  } finally {
    c.release();
  }
}

export async function closePool() {
  if (g.__pool) { await g.__pool.end(); g.__pool = undefined; }
}
