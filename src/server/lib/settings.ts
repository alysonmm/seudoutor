import { one, pool, type Db } from '../db';

// Cache curto em memória: parâmetros mudam raramente e eram lidos a cada cálculo de horários (custo na busca).
const cache = new Map<string, { v: unknown; at: number }>();
const TTL_MS = 10_000;

export async function setting<T = unknown>(key: string, fallback: T, db: Db = pool()): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS && process.env.NODE_ENV !== 'test') return hit.v as T;
  const r = await one<{ value: T }>('SELECT value FROM system_settings WHERE key=$1', [key], db);
  const v = r ? r.value : fallback;
  cache.set(key, { v, at: Date.now() });
  return v;
}
