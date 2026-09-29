import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from 'pg';

if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');

export async function migrate(url = process.env.DATABASE_URL ?? 'postgres://seudoutor:seudoutor@localhost:5432/seudoutor_dev', log = console.log) {
  const dir = path.resolve(process.cwd(), 'db/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(f)) {
        if (applied.get(f) !== checksum) throw new Error(`Migração ${f} foi alterada após aplicada. Crie uma nova migração.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)', [f, checksum]);
        await client.query('COMMIT');
        log(`aplicada: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Falha em ${f}: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  migrate().then(() => console.log('migrações em dia')).catch((e) => { console.error(e.message); process.exit(1); });
}
