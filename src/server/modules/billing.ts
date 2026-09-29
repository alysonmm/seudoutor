import { z } from 'zod';
import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query, withTx, type Db } from '../db';
import { config } from '../config';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound, unavailable } from '../lib/errors';
import { hmacHex, safeEqualHex, randomToken } from '../lib/crypto';
import { setting } from '../lib/settings';
import { authorizeOrg, requirePlatform } from './authz';
import { recordAcceptance } from './documents';

// ---------------------------------------------------------------------------
// Adaptador de PSP. Sandbox = SOMENTE fora de produção e claramente identificado. Produção sem PSP: falha fechada.
// ---------------------------------------------------------------------------
export interface PspCheckout { providerSessionRef: string; checkoutUrl: string }
export interface PspAdapter { name: string; createCheckout(input: { subscriptionId: string; amountCents: number; currency: string; period: string }): Promise<PspCheckout> }

const sandboxPsp: PspAdapter = {
  name: 'sandbox',
  async createCheckout() {
    const ref = 'sbx_' + randomToken(9);
    return { providerSessionRef: ref, checkoutUrl: `${config.baseUrl}/sandbox-psp/${ref}` };
  },
};
export function pspAdapter(): PspAdapter {
  if (config.pspMode === 'sandbox' && !config.isProd) return sandboxPsp;
  throw unavailable('psp_not_configured', 'Cobrança indisponível: provedor de pagamento não contratado/configurado neste ambiente');
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
export async function listPlans() {
  return query(
    `SELECT p.id AS plan_id, p.name, pv.id AS plan_version_id, pv.version, pv.price_monthly_cents, pv.price_yearly_cents, pv.currency, pv.limits, pv.features, pv.is_hypothesis
       FROM subscription_plans p JOIN LATERAL (SELECT * FROM plan_versions v WHERE v.plan_id = p.id AND v.active ORDER BY version DESC LIMIT 1) pv ON true
      WHERE p.active ORDER BY pv.price_monthly_cents`);
}

/** Nova versão de plano: não altera assinaturas existentes (cada uma guarda a versão contratada). */
export async function publishPlanVersion(actor: string, planId: string, input: { priceMonthlyCents: number; priceYearlyCents: number; limits: Record<string, number>; features?: Record<string, unknown> }) {
  await requirePlatform(actor, 'subscription.admin');
  const last = await one<{ v: number }>('SELECT COALESCE(max(version),0) v FROM plan_versions WHERE plan_id=$1', [planId]);
  const r = await one<{ id: string }>(
    `INSERT INTO plan_versions(plan_id, version, price_monthly_cents, price_yearly_cents, limits, features, is_hypothesis) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
    [planId, last!.v + 1, input.priceMonthlyCents, input.priceYearlyCents, JSON.stringify(input.limits), JSON.stringify(input.features ?? {})]);
  await audit({ actorUserId: actor, action: 'plan.version_published', objectType: 'plan_version', objectId: r!.id });
  return { id: r!.id, version: last!.v + 1 };
}

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------
export const checkoutSchema = z.object({
  planId: z.string(), period: z.enum(['monthly', 'yearly']),
  startTrial: z.boolean().default(false),
  acceptContract: z.literal(true, { error: 'Aceite o contrato para continuar' }),
});

async function currentSub(db: Db, orgId: string) {
  return one<any>(`SELECT * FROM subscriptions WHERE organization_id=$1 AND status NOT IN ('cancelled','expired') FOR UPDATE`, [orgId], db);
}

/**
 * Teste gratuito (sem cartão) ou início de contratação. Contratação fica `pending` até o webhook do PSP confirmar
 * o pagamento (AC11): o redirecionamento do navegador nunca ativa a assinatura.
 */
export async function startSubscription(actor: string, orgId: string, raw: z.input<typeof checkoutSchema>) {
  await authorizeOrg(actor, orgId, 'billing.manage');
  const c = checkoutSchema.parse(raw);
  return withTx(async (tx) => {
    const pv = await one<any>(`SELECT pv.* FROM plan_versions pv WHERE pv.plan_id=$1 AND pv.active ORDER BY version DESC LIMIT 1`, [c.planId], tx);
    if (!pv) throw notFound('plan_not_found');
    const prev = await currentSub(tx, orgId);
    if (prev && !(prev.status === 'pending' || prev.status === 'trialing')) throw conflict('subscription_exists', 'Já existe uma assinatura vigente');
    const amount = c.period === 'monthly' ? pv.price_monthly_cents : pv.price_yearly_cents;
    const acc = await recordAcceptance(tx, actor, 'contrato-profissional', orgId, { via: 'checkout', plan: c.planId, period: c.period, amountCents: amount });
    if (c.startTrial) {
      if (prev) await tx.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [prev.id]);
      const trialUsed = await one("SELECT 1 FROM subscriptions WHERE organization_id=$1 AND trial_ends_at IS NOT NULL AND status <> 'pending'", [orgId], tx);
      if (trialUsed) throw conflict('trial_already_used', 'O teste gratuito já foi utilizado por esta organização');
      const days = await setting<number>('trial_days', 14, tx);
      const s = await one<{ id: string }>(
        `INSERT INTO subscriptions(organization_id, plan_version_id, billing_period, status, trial_ends_at, amount_cents, contract_acceptance_id)
         VALUES ($1,$2,$3,'trialing', now() + make_interval(days => $4::int), $5, $6) RETURNING id`, [orgId, pv.id, c.period, days, amount, acc.id], tx);
      await audit({ actorUserId: actor, organizationId: orgId, action: 'subscription.trial_started', objectType: 'subscription', objectId: s!.id }, tx);
      return { subscriptionId: s!.id, status: 'trialing', trialDays: days, chargedNow: 0, summary: summary(pv, c.period, amount, true) };
    }
    const psp = pspAdapter();
    let s: { id: string } | undefined;
    if (prev?.status === 'trialing') {
      // Contratar durante o teste: mantém o teste vigente até o webhook confirmar o pagamento (sem perder a publicação).
      await tx.query('UPDATE subscriptions SET plan_version_id=$2, billing_period=$3, amount_cents=$4, contract_acceptance_id=$5, provider=$6, updated_at=now() WHERE id=$1', [prev.id, pv.id, c.period, amount, acc.id, psp.name]);
      s = { id: prev.id };
    } else {
      if (prev) await tx.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [prev.id]);
      s = await one<{ id: string }>(
        `INSERT INTO subscriptions(organization_id, plan_version_id, billing_period, status, amount_cents, contract_acceptance_id, provider)
         VALUES ($1,$2,$3,'pending',$4,$5,$6) RETURNING id`, [orgId, pv.id, c.period, amount, acc.id, psp.name], tx);
    }
    const co = await psp.createCheckout({ subscriptionId: s!.id, amountCents: amount, currency: pv.currency, period: c.period });
    await tx.query('UPDATE subscriptions SET provider_subscription_ref=$2 WHERE id=$1', [s!.id, co.providerSessionRef]);
    await tx.query(`INSERT INTO checkout_sessions(organization_id, subscription_id, provider, provider_session_ref, created_by) VALUES ($1,$2,$3,$4,$5)`, [orgId, s!.id, psp.name, co.providerSessionRef, actor]);
    await audit({ actorUserId: actor, organizationId: orgId, action: 'subscription.checkout_created', objectType: 'subscription', objectId: s!.id }, tx);
    return { subscriptionId: s!.id, status: prev?.status === 'trialing' ? 'trialing' : 'pending', checkoutUrl: co.checkoutUrl, providerSessionRef: co.providerSessionRef, summary: summary(pv, c.period, amount, false) };
  });
}

/** Informações obrigatórias antes do pagamento: valor total, periodicidade, renovação, início, cancelamento. */
function summary(pv: any, period: string, amount: number, trial: boolean) {
  return {
    plan: pv.plan_id, planVersion: pv.version, totalCents: amount, currency: pv.currency,
    periodicity: period === 'monthly' ? 'mensal' : 'anual (cobrança única do total anual)',
    autoRenew: true, cancelAnytime: 'Cancelamento pelo painel, com comprovante e data de efeito', trial,
    limits: pv.limits,
  };
}

export async function getSubscription(actor: string, orgId: string) {
  await authorizeOrg(actor, orgId, 'billing.read');
  const s = await one<any>(
    `SELECT s.id, s.status, s.billing_period, s.trial_ends_at, s.current_period_start, s.current_period_end, s.grace_ends_at, s.cancel_requested_at,
            s.amount_cents, s.currency, pv.plan_id, pv.version, pv.limits FROM subscriptions s JOIN plan_versions pv ON pv.id = s.plan_version_id
      WHERE s.organization_id=$1 ORDER BY s.created_at DESC LIMIT 1`, [orgId]);
  const invoices = s ? await query('SELECT id, amount_cents, currency, status, period_start, period_end, receipt_number, paid_at FROM billing_invoices WHERE subscription_id=$1 ORDER BY period_start DESC', [s.id]) : [];
  return { subscription: s ?? null, invoices };
}

/** Cancelamento pelo painel, com comprovante e data de efeito. Sem estorno automático. */
export async function cancelSubscription(actor: string, orgId: string) {
  await authorizeOrg(actor, orgId, 'billing.manage');
  return withTx(async (tx) => {
    const s = await currentSub(tx, orgId);
    if (!s) throw notFound('no_subscription');
    let effective: Date; let status: string;
    if (s.status === 'trialing' || s.status === 'pending') { effective = new Date(); status = 'cancelled'; await tx.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now(), cancel_requested_at=now(), updated_at=now() WHERE id=$1", [s.id]); }
    else if (s.status === 'cancel_at_period_end') return { status: s.status, effectiveAt: s.current_period_end, receipt: null, alreadyRequested: true };
    else { effective = new Date(s.current_period_end); status = 'cancel_at_period_end'; await tx.query("UPDATE subscriptions SET status='cancel_at_period_end', cancel_requested_at=now(), updated_at=now() WHERE id=$1", [s.id]); }
    const receipt = 'CANC-' + s.id.slice(0, 8).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
    await audit({ actorUserId: actor, organizationId: orgId, action: 'subscription.cancel_requested', objectType: 'subscription', objectId: s.id, metadata: { effectiveAt: effective.toISOString(), receipt } }, tx);
    return { status, effectiveAt: effective.toISOString(), receipt, alreadyRequested: false };
  });
}

export async function requestRefund(actor: string, orgId: string, input: { kind: 'withdrawal' | 'refund' | 'other'; reason?: string }) {
  await authorizeOrg(actor, orgId, 'billing.manage');
  const s = await one<any>('SELECT id FROM subscriptions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 1', [orgId]);
  if (!s) throw notFound('no_subscription');
  const protocol = 'RS-' + Date.now().toString(36).toUpperCase() + randomToken(2).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  await query(`INSERT INTO refund_requests(subscription_id, organization_id, kind, reason, protocol, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [s.id, orgId, input.kind, input.reason?.slice(0, 1000) ?? null, protocol, actor]);
  await audit({ actorUserId: actor, organizationId: orgId, action: 'subscription.refund_requested', metadata: { protocol } });
  return { protocol }; // análise por humano conforme contrato e direitos aplicáveis; nada é decidido automaticamente
}

// ---------------------------------------------------------------------------
// Webhook do PSP: autoridade da liquidação
// ---------------------------------------------------------------------------
const TOLERANCE_SECONDS = 300;
/** Assinatura: HMAC-SHA256 de `${timestamp}.${rawBody}` com o segredo do webhook. */
export function signWebhook(rawBody: string, timestamp: number, secret = config.pspWebhookSecret) {
  return hmacHex(secret, `${timestamp}.${rawBody}`);
}

const eventSchema = z.object({
  id: z.string().min(3), type: z.enum(['payment.succeeded', 'payment.failed', 'subscription.renewed', 'payment.refunded']),
  createdAt: z.string().datetime(),
  data: z.object({
    subscriptionRef: z.string(), paymentRef: z.string(), amountCents: z.number().int(), currency: z.string().length(3),
    periodStart: z.string().datetime().optional(), periodEnd: z.string().datetime().optional(),
  }),
});

export async function handlePspWebhook(rawBody: string, signature: string | null, timestampHeader: string | null, now = new Date()) {
  if (!signature || !timestampHeader) throw new AppError(401, 'invalid_signature');
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > TOLERANCE_SECONDS) throw new AppError(401, 'stale_or_invalid_timestamp'); // proteção contra replay
  if (!safeEqualHex(signWebhook(rawBody, ts), signature)) throw new AppError(401, 'invalid_signature');
  const ev = eventSchema.parse(JSON.parse(rawBody));
  const provider = config.pspMode === 'sandbox' ? 'sandbox' : 'psp';
  return withTx(async (tx) => {
    const ins = await tx.query(`INSERT INTO provider_events(provider, event_id, event_type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [provider, ev.id, ev.type, rawBody]);
    if (!ins.rowCount) return { status: 'duplicate' as const }; // evento repetido: sem efeito
    const evId = ins.rows[0].id;
    const result = await applyEvent(tx, provider, ev);
    await tx.query('UPDATE provider_events SET processed_at=now(), result=$2 WHERE id=$1', [evId, result]);
    return { status: result };
  });
}

async function applyEvent(tx: PoolClient, provider: string, ev: z.infer<typeof eventSchema>): Promise<string> {
  const sub = await one<any>('SELECT * FROM subscriptions WHERE provider_subscription_ref=$1 FOR UPDATE', [ev.data.subscriptionRef], tx);
  if (!sub) return 'ignored_unknown_subscription';
  // valor e moeda precisam bater com o contratado
  if (ev.type === 'payment.succeeded' || ev.type === 'subscription.renewed') {
    if (ev.data.amountCents !== sub.amount_cents || ev.data.currency !== sub.currency) {
      await audit({ actorKind: 'webhook', organizationId: sub.organization_id, action: 'billing.amount_mismatch', objectType: 'subscription', objectId: sub.id }, tx);
      return 'rejected_amount_mismatch';
    }
  }
  // eventos fora de ordem: ignora o que for mais antigo que o último aplicado
  if (sub.last_provider_event_at && new Date(ev.createdAt) < new Date(sub.last_provider_event_at)) return 'ignored_out_of_order';
  const evTime = new Date(ev.createdAt);
  const periodMs = sub.billing_period === 'yearly' ? 365 * 86400_000 : 30 * 86400_000;
  const pStart = ev.data.periodStart ? new Date(ev.data.periodStart) : evTime;
  const pEnd = ev.data.periodEnd ? new Date(ev.data.periodEnd) : new Date(pStart.getTime() + periodMs);
  if (ev.type === 'payment.succeeded' || ev.type === 'subscription.renewed') {
    const inv = await one<{ id: string; status: string }>(
      `INSERT INTO billing_invoices(subscription_id, organization_id, amount_cents, currency, period_start, period_end, status, paid_at, provider_invoice_ref, receipt_number)
       VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9)
       ON CONFLICT (subscription_id, period_start) DO UPDATE SET status = CASE WHEN billing_invoices.status='paid' THEN 'paid' ELSE 'paid' END
       RETURNING id, status`,
      [sub.id, sub.organization_id, sub.amount_cents, sub.currency, pStart, pEnd, evTime, ev.data.paymentRef, 'REC-' + ev.data.paymentRef.slice(-8).toUpperCase()], tx); // recibo operacional (não é nota fiscal)
    await tx.query(
      `INSERT INTO billing_payments(invoice_id, provider, provider_payment_ref, amount_cents, currency, status, occurred_at) VALUES ($1,$2,$3,$4,$5,'paid',$6)
       ON CONFLICT (provider, provider_payment_ref) DO NOTHING`, [inv!.id, provider, ev.data.paymentRef, ev.data.amountCents, ev.data.currency, evTime]);
    const keepCancel = sub.status === 'cancel_at_period_end';
    await tx.query(
      `UPDATE subscriptions SET status=$2, current_period_start=$3, current_period_end=$4, grace_ends_at=NULL, last_provider_event_at=$5, updated_at=now() WHERE id=$1`,
      [sub.id, keepCancel ? 'cancel_at_period_end' : 'active', pStart, pEnd, evTime]);
    if (sub.status !== 'active') {
      await tx.query(`INSERT INTO outbox_events(event_type, payload, dedupe_key) VALUES ('SubscriptionActivated', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING`,
        [JSON.stringify({ subscriptionId: sub.id }), `subact:${sub.id}:${pStart.toISOString()}`]);
    }
    await audit({ actorKind: 'webhook', organizationId: sub.organization_id, action: 'subscription.payment_confirmed', objectType: 'subscription', objectId: sub.id }, tx);
    return 'applied';
  }
  if (ev.type === 'payment.failed') {
    const days = await setting<number>('billing_grace_days', 7, tx);
    if (sub.status === 'pending') { await tx.query('UPDATE subscriptions SET last_provider_event_at=$2 WHERE id=$1', [sub.id, evTime]); return 'applied_pending_stays_pending'; }
    await tx.query(`UPDATE subscriptions SET status='grace_period', grace_ends_at=now() + make_interval(days => $2::int), last_provider_event_at=$3, updated_at=now() WHERE id=$1 AND status IN ('active','trialing')`, [sub.id, days, evTime]);
    await tx.query(`INSERT INTO outbox_events(event_type, payload, dedupe_key) VALUES ('SubscriptionPastDue', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING`, [JSON.stringify({ subscriptionId: sub.id }), `pastdue:${sub.id}:${ev.id}`]);
    return 'applied';
  }
  if (ev.type === 'payment.refunded') {
    await tx.query(`UPDATE billing_payments SET status='refunded' WHERE provider_payment_ref=$1`, [ev.data.paymentRef]);
    await tx.query('UPDATE subscriptions SET last_provider_event_at=$2 WHERE id=$1', [sub.id, evTime]);
    return 'applied';
  }
  return 'ignored';
}

/** Rotina periódica: fim de teste, fim de carência, fim do período cancelado. Não apaga dados nem cancela pacientes. */
export async function sweepSubscriptions() {
  const r1 = await query(`UPDATE subscriptions SET status='expired', updated_at=now() WHERE status='trialing' AND trial_ends_at <= now() RETURNING id`);
  const r2 = await query(`UPDATE subscriptions SET status='past_due', updated_at=now() WHERE status='grace_period' AND grace_ends_at <= now() RETURNING id`);
  const r3 = await query(`UPDATE subscriptions SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE status='cancel_at_period_end' AND current_period_end <= now() RETURNING id`);
  return { trialsExpired: r1.length, pastDue: r2.length, cancelled: r3.length };
}

export { createHmac, badRequest };
