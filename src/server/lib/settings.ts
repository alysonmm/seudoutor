import { one, pool, type Db } from '../db';

export async function setting<T = unknown>(key: string, fallback: T, db: Db = pool()): Promise<T> {
  const r = await one<{ value: T }>('SELECT value FROM system_settings WHERE key=$1', [key], db);
  return r ? r.value : fallback;
}
