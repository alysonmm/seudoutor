/**
 * Carga sintética: 100 usuários concorrentes. Mede busca e confirmação (sem integrações externas).
 * Usa o banco de TESTE local; os números descrevem ESTE ambiente, não capacidade de produção.
 */
import os from 'node:os';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://seudoutor:seudoutor@localhost:5432/seudoutor_test';
(process.env as any).NODE_ENV = 'test';
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX ?? '20';

const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
async function timed<T>(fn: () => Promise<T>) { const t = performance.now(); try { await fn(); return { ms: performance.now() - t, ok: true }; } catch { return { ms: performance.now() - t, ok: false }; } }

async function main() {
  const { migrate } = await import('./migrate');
  await migrate(process.env.DATABASE_URL!, () => {});
  const { seedLegalDrafts } = await import('../src/server/seed/legal');
  await seedLegalDrafts();
  const { makeWorld } = await import('../tests/world');
  const { newUser, rnd } = await import('../tests/helpers');
  const { searchPractitioners } = await import('../src/server/modules/search');
  const { bookAppointment } = await import('../src/server/modules/booking');
  const { closePool } = await import('../src/server/db');

  const city = 'Cidade Bench ' + rnd();
  console.log('preparando 10 consultórios e 100 usuários sintéticos…');
  const worlds: Awaited<ReturnType<typeof makeWorld>>[] = [];
  for (let i = 0; i < 10; i++) worlds.push(await makeWorld({ city }));
  const users: Awaited<ReturnType<typeof newUser>>[] = [];
  for (let i = 0; i < 100; i++) users.push(await newUser('Bench ' + i));

  const s = await Promise.all(users.map(() => timed(() => searchPractitioners({ city }))));
  const searchMs = s.map((x) => x.ms);
  const b = await Promise.all(users.map((u, i) => timed(() => bookAppointment(u.id, { offeringId: worlds[i % 10].offeringId, startsAt: worlds[i % 10].slots[Math.floor(i / 10)].startsAt, payerType: 'private' }))));
  const bookMs = b.map((x) => x.ms);
  const out = {
    ambiente: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, pgPool: process.env.DB_POOL_MAX, banco: 'PostgreSQL local, mesma máquina' },
    volume: { profissionais: 10, usuariosConcorrentes: 100, resultadosPorBusca: 10 },
    busca: { ok: s.filter((x) => x.ok).length, p50: Math.round(pct(searchMs, 50)), p95: Math.round(pct(searchMs, 95)), p99: Math.round(pct(searchMs, 99)), metaP95: 1500 },
    confirmacao: { ok: b.filter((x) => x.ok).length, p50: Math.round(pct(bookMs, 50)), p95: Math.round(pct(bookMs, 95)), p99: Math.round(pct(bookMs, 99)), metaP95: 2000 },
  };
  console.log(JSON.stringify(out, null, 2));
  await closePool();
}
main().catch((e) => { console.error(e); process.exit(1); });
