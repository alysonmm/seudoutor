import { pool, type Db } from '../db';
import { tooMany } from './errors';

/** Contador por janela fixa no banco (funciona com várias instâncias). Lança 429 ao exceder. */
export async function rateLimit(key: string, max: number, windowSeconds: number, db: Db = pool()) {
  const rows = await db.query(
    `INSERT INTO rate_limits(key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowSeconds],
  );
  if (rows.rows[0].count > max) throw tooMany();
}
