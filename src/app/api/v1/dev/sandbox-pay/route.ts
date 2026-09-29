import { z } from 'zod';
import { handle, body } from '@/server/http';
import { config } from '@/server/config';
import { notFound } from '@/server/lib/errors';
import { one } from '@/server/db';
import { handlePspWebhook, signWebhook } from '@/server/modules/billing';

/** SOMENTE desenvolvimento/homologação: simula o PSP sandbox chamando o webhook assinado. Em produção responde 404. */
export const POST = handle(async (req) => {
  if (config.isProd || config.pspMode !== 'sandbox') throw notFound();
  const b = await body(req, z.object({ ref: z.string(), outcome: z.enum(['success', 'failure']) }));
  const sub = await one<any>('SELECT amount_cents, currency FROM subscriptions WHERE provider_subscription_ref=$1', [b.ref]);
  if (!sub) throw notFound();
  const ev = JSON.stringify({ id: 'evt_sbx_' + crypto.randomUUID(), type: b.outcome === 'success' ? 'payment.succeeded' : 'payment.failed', createdAt: new Date().toISOString(),
    data: { subscriptionRef: b.ref, paymentRef: 'pay_sbx_' + crypto.randomUUID(), amountCents: sub.amount_cents, currency: sub.currency } });
  const ts = Math.floor(Date.now() / 1000);
  return handlePspWebhook(ev, signWebhook(ev, ts), String(ts));
});
