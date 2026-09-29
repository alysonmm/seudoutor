/** Worker: outbox, notificações, exportações, limpeza de reservas vencidas e rotina de assinaturas. Um processo separado do web. */
import fs from 'node:fs';
if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
import { processOutbox, processDueJobs } from '../src/server/modules/notifications';
import { sweepExpiredHolds } from '../src/server/modules/booking';
import { processExports } from '../src/server/modules/reports';
import { sweepSubscriptions } from '../src/server/modules/billing';

let stop = false;
process.on('SIGTERM', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });

async function tick() {
  const r = { outbox: await processOutbox(), jobs: await processDueJobs(), holds: await sweepExpiredHolds(), exports: await processExports() };
  return r;
}
async function main() {
  console.log('worker iniciado');
  let n = 0;
  while (!stop) {
    try {
      const r = await tick();
      if (r.outbox || r.jobs.sent || r.jobs.failed || r.holds || r.exports) console.log(new Date().toISOString(), JSON.stringify(r));
      if (n++ % 60 === 0) await sweepSubscriptions();
    } catch (e) { console.error('erro no ciclo do worker:', (e as Error).message); }
    await new Promise((res) => setTimeout(res, 5000));
  }
}
main();
