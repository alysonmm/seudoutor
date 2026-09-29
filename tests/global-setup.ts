import { Client } from 'pg';
import { migrate } from '../scripts/migrate';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://seudoutor:seudoutor@localhost:5432/seudoutor_test';
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); // migração em banco vazio a cada execução
  await c.end();
  await migrate(url, () => {});
  process.env.DATABASE_URL = url;
  const { seedLegalDrafts } = await import('../src/server/seed/legal');
  await seedLegalDrafts();
  const { closePool } = await import('../src/server/db');
  await closePool();
}
