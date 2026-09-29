import { describe, it, expect, afterAll } from 'vitest';
import { call, newUser, rnd, setPlan, count, sessionFor } from './helpers';
import { makeWorld, makeAdmin, patientSession } from './world';
import { closePool, one, query, pool } from '../src/server/db';
import * as B from '../src/server/modules/booking';
import * as billing from '../src/server/modules/billing';
import * as privacy from '../src/server/modules/privacy';
import * as quality from '../src/server/modules/quality';
import * as reports from '../src/server/modules/reports';
import * as incidents from '../src/server/modules/incidents';
import { authorizeOrg } from '../src/server/modules/authz';
import { searchPractitioners } from '../src/server/modules/search';
import * as webhookRoute from '../src/app/api/v1/webhooks/psp/route';
import * as subRoute from '../src/app/api/v1/organizations/[orgId]/subscription/route';
import * as metricsRoute from '../src/app/api/v1/admin/metrics/route';
import * as legalRoute from '../src/app/api/v1/legal/[key]/route';
import fs from 'node:fs';

afterAll(async () => { await closePool(); });

async function orgWithoutPlan() {
  return makeWorld({ plan: null, city: 'Cidade Sem Plano ' + rnd() });
}

function webhook(ev: Record<string, unknown>, opts: { ts?: number; sig?: string } = {}) {
  const raw = JSON.stringify(ev);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return call(webhookRoute.POST as any, { rawBody: raw, headers: { 'x-psp-timestamp': String(ts), 'x-psp-signature': opts.sig ?? billing.signWebhook(raw, ts) } });
}
const evt = (over: Record<string, any> = {}) => ({
  id: 'evt_' + rnd() + rnd(), type: 'payment.succeeded', createdAt: new Date().toISOString(),
  data: { subscriptionRef: 'x', paymentRef: 'pay_' + rnd() + rnd(), amountCents: 12900, currency: 'BRL' }, ...over,
});

describe('assinatura SaaS (AC10, AC11)', () => {
  it('teste gratuito sem cartão libera publicação; sem contratação expressa expira e retira da busca', async () => {
    const w = await orgWithoutPlan();
    const city = (await one<any>('SELECT city FROM locations WHERE id=$1', [w.locationId])).city;
    expect((await searchPractitioners({ city })).total).toBe(0); // sem assinatura/teste: não publica
    const t = await billing.startSubscription(w.org.user.id, w.orgId, { planId: 'profissional', period: 'monthly', startTrial: true, acceptContract: true });
    expect(t.status).toBe('trialing');
    expect(t.chargedNow).toBe(0);
    expect((await searchPractitioners({ city })).total).toBe(1);
    await expect(billing.startSubscription(w.org.user.id, w.orgId, { planId: 'profissional', period: 'monthly', startTrial: true, acceptContract: true })).rejects.toMatchObject({ code: 'trial_already_used' });
    await query("UPDATE subscriptions SET trial_ends_at = now() - interval '1 minute' WHERE organization_id=$1", [w.orgId]);
    expect((await searchPractitioners({ city })).total).toBe(0); // vencido logicamente, mesmo sem rotina
    expect(await billing.sweepSubscriptions()).toMatchObject({ trialsExpired: expect.any(Number) });
    expect((await one<any>('SELECT status FROM subscriptions WHERE organization_id=$1', [w.orgId])).status).toBe('expired');
  });

  it('AC11: checkout redirecionado sem pagamento confirmado mantém a assinatura pendente e não libera recursos', async () => {
    const w = await orgWithoutPlan();
    const c = await billing.startSubscription(w.org.user.id, w.orgId, { planId: 'profissional', period: 'yearly', acceptContract: true });
    expect(c.status).toBe('pending');
    expect(c.summary.totalCents).toBe(129000);
    expect(c.summary.periodicity).toMatch(/anual/);
    expect(c.summary.autoRenew).toBe(true);
    // "voltou do checkout" sem webhook => segue pendente
    const s = await billing.getSubscription(w.org.user.id, w.orgId);
    expect(s.subscription.status).toBe('pending');
    const { isOrgEntitled } = await import('../src/server/modules/entitlements');
    expect(await isOrgEntitled(w.orgId)).toBe(false);
    const acc = await one<any>('SELECT context FROM terms_acceptances WHERE organization_id=$1 ORDER BY accepted_at DESC LIMIT 1', [w.orgId]);
    expect(acc.context.amountCents).toBe(129000);
  });

  it('AC10: webhook válido ativa; falso, adulterado, antigo, duplicado e fora de ordem não causam efeito indevido', async () => {
    const w = await orgWithoutPlan();
    const c = await billing.startSubscription(w.org.user.id, w.orgId, { planId: 'profissional', period: 'monthly', acceptContract: true });
    const ref = c.providerSessionRef!;
    const base = evt({ data: { subscriptionRef: ref, paymentRef: 'pay_' + rnd() + rnd(), amountCents: 12900, currency: 'BRL' } });
    // assinatura falsa
    expect((await webhook(base, { sig: 'a'.repeat(64) })).status).toBe(401);
    // timestamp antigo (replay)
    const raw = JSON.stringify(base); const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await webhook(base, { ts: old, sig: billing.signWebhook(raw, old) })).status).toBe(401);
    // corpo adulterado após assinar
    const ts = Math.floor(Date.now() / 1000);
    const forged = await call(webhookRoute.POST as any, { rawBody: raw.replace('12900', '100'), headers: { 'x-psp-timestamp': String(ts), 'x-psp-signature': billing.signWebhook(raw, ts) } });
    expect(forged.status).toBe(401);
    expect((await billing.getSubscription(w.org.user.id, w.orgId)).subscription.status).toBe('pending');
    // valor divergente é rejeitado, mesmo assinado
    const wrongAmt = await webhook(evt({ data: { subscriptionRef: ref, paymentRef: 'pay_x' + rnd(), amountCents: 100, currency: 'BRL' } }));
    expect(wrongAmt.data.status).toBe('rejected_amount_mismatch');
    expect((await billing.getSubscription(w.org.user.id, w.orgId)).subscription.status).toBe('pending');
    // válido
    const ok = await webhook(base);
    expect(ok.status).toBe(200);
    expect(ok.data.status).toBe('applied');
    // duplicado (mesmo id) e reenvio concorrente
    const dups = await Promise.all([webhook(base), webhook(base), webhook(base)]);
    expect(dups.every((d) => d.data.status === 'duplicate')).toBe(true);
    expect(await count("SELECT count(*) n FROM billing_invoices WHERE subscription_id=(SELECT id FROM subscriptions WHERE provider_subscription_ref=$1)", [ref])).toBe(1);
    expect(await count('SELECT count(*) n FROM billing_payments WHERE provider_payment_ref=$1', [base.data.paymentRef])).toBe(1);
    const s = (await billing.getSubscription(w.org.user.id, w.orgId));
    expect(s.subscription.status).toBe('active');
    expect(s.invoices[0].receipt_number).toMatch(/^REC-/); // recibo operacional
    // fora de ordem: falha ANTIGA chega depois do pagamento novo
    const stale = await webhook(evt({ type: 'payment.failed', createdAt: new Date(Date.now() - 86400_000).toISOString(), data: { subscriptionRef: ref, paymentRef: 'pay_old' + rnd(), amountCents: 12900, currency: 'BRL' } }));
    expect(stale.data.status).toBe('ignored_out_of_order');
    expect((await billing.getSubscription(w.org.user.id, w.orgId)).subscription.status).toBe('active');
    // assinatura de evento com segredo errado
    const raw2 = JSON.stringify(evt()); const ts2 = Math.floor(Date.now() / 1000);
    expect((await call(webhookRoute.POST as any, { rawBody: raw2, headers: { 'x-psp-timestamp': String(ts2), 'x-psp-signature': billing.signWebhook(raw2, ts2, 'outro-segredo') } })).status).toBe(401);
  });

  it('renovação é idempotente por período; falha de pagamento abre carência sem apagar dados ou cancelar consultas', async () => {
    const w = await orgWithoutPlan();
    const c = await billing.startSubscription(w.org.user.id, w.orgId, { planId: 'profissional', period: 'monthly', acceptContract: true });
    const ref = c.providerSessionRef!;
    const start = new Date(Date.now() - 5 * 86400_000);
    await webhook(evt({ createdAt: start.toISOString(), data: { subscriptionRef: ref, paymentRef: 'p1' + rnd(), amountCents: 12900, currency: 'BRL', periodStart: start.toISOString() } }));
    const renew = () => webhook(evt({ type: 'subscription.renewed', data: { subscriptionRef: ref, paymentRef: 'p2' + rnd(), amountCents: 12900, currency: 'BRL', periodStart: new Date(Date.now() - 1000).toISOString() } }));
    await renew();
    // outro id de evento para o MESMO período de cobrança não duplica fatura
    await webhook(evt({ type: 'subscription.renewed', data: { subscriptionRef: ref, paymentRef: 'p3' + rnd(), amountCents: 12900, currency: 'BRL', periodStart: start.toISOString() } }));
    expect(await count("SELECT count(*) n FROM billing_invoices WHERE subscription_id=(SELECT id FROM subscriptions WHERE provider_subscription_ref=$1)", [ref])).toBe(2);
    // consulta existente
    const pat = await newUser();
    const a = await B.bookAppointment(pat.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await webhook(evt({ type: 'payment.failed', createdAt: new Date(Date.now() + 1000).toISOString(), data: { subscriptionRef: ref, paymentRef: 'pf' + rnd(), amountCents: 12900, currency: 'BRL' } }));
    expect((await one<any>('SELECT status, grace_ends_at FROM subscriptions WHERE provider_subscription_ref=$1', [ref])).status).toBe('grace_period');
    // após a carência: restrito a NOVAS marcações, mas a consulta existente e o acesso do painel permanecem
    await query("UPDATE subscriptions SET grace_ends_at = now() - interval '1 minute' WHERE provider_subscription_ref=$1", [ref]);
    await billing.sweepSubscriptions();
    expect((await one<any>('SELECT status FROM subscriptions WHERE provider_subscription_ref=$1', [ref])).status).toBe('past_due');
    const pat2 = await newUser();
    await expect(B.bookAppointment(pat2.id, { offeringId: w.offeringId, startsAt: w.slots[1].startsAt, payerType: 'private' })).rejects.toMatchObject({ code: 'practitioner_not_bookable' });
    expect((await one<any>('SELECT status FROM appointments WHERE id=$1', [a.body.id])).status).toBe('scheduled');
    await expect(B.listOrgAppointments(w.org.user.id, w.orgId, new Date(0).toISOString(), new Date(Date.now() + 999999999).toISOString())).resolves.toHaveLength(1);
    await expect(billing.getSubscription(w.org.user.id, w.orgId)).resolves.toBeTruthy(); // painel de assinatura acessível
    expect(await count('SELECT count(*) n FROM locations WHERE organization_id=$1', [w.orgId])).toBe(1); // dados preservados
  });

  it('cancelamento no painel: comprovante e data de efeito; repetição é idempotente; versão contratada não muda com novo preço', async () => {
    const w = await orgWithoutPlan();
    const c = await billing.startSubscription(w.org.user.id, w.orgId, { planId: 'essencial', period: 'monthly', acceptContract: true });
    await webhook(evt({ data: { subscriptionRef: c.providerSessionRef!, paymentRef: 'p' + rnd(), amountCents: 6900, currency: 'BRL' } }));
    const admin = await makeAdmin('platform_admin');
    await billing.publishPlanVersion(admin.user.id, 'essencial', { priceMonthlyCents: 9900, priceYearlyCents: 99000, limits: { practitioners: 1, locations: 1, members: 1, whatsapp_monthly_quota: 0 } });
    const s = await billing.getSubscription(w.org.user.id, w.orgId);
    expect(s.subscription.amount_cents).toBe(6900);
    expect(s.subscription.version).toBe(1);
    const k1 = await billing.cancelSubscription(w.org.user.id, w.orgId);
    expect(k1.status).toBe('cancel_at_period_end');
    expect(k1.receipt).toMatch(/^CANC-/);
    expect(new Date(k1.effectiveAt).getTime()).toBeGreaterThan(Date.now());
    const k2 = await billing.cancelSubscription(w.org.user.id, w.orgId);
    expect(k2.alreadyRequested).toBe(true);
    expect((await billing.requestRefund(w.org.user.id, w.orgId, { kind: 'withdrawal', reason: 'teste' })).protocol).toMatch(/^RS-/);
    const { isOrgEntitled } = await import('../src/server/modules/entitlements');
    expect(await isOrgEntitled(w.orgId)).toBe(true); // vigente até o fim do período pago
  });

  it('só quem tem billing.* vê/gerencia assinatura; API de checkout exige aceite do contrato', async () => {
    const w = await makeWorld({ plan: 'clinica' });
    const stranger = await makeWorld();
    const r = await call(subRoute.GET, { cookie: stranger.org.cookie, params: { orgId: w.orgId } });
    expect(r.status).toBe(403);
    const noAccept = await call(subRoute.POST, { cookie: w.org.cookie, params: { orgId: w.orgId }, body: { planId: 'clinica', period: 'monthly', acceptContract: false } });
    expect(noAccept.status).toBe(400);
  });

  it('cotas do plano: limite de locais e de equipe é aplicado no servidor', async () => {
    const w = await makeWorld({ plan: 'essencial' });
    const { createLocation } = await import('../src/server/modules/catalog');
    await expect(createLocation(w.org.user.id, w.orgId, { name: 'Segunda', street: 'Rua Y', neighborhood: 'Bairro', city: 'Cidade', uf: 'SP', timezone: 'America/Sao_Paulo', accessibility: [] })).rejects.toMatchObject({ code: 'plan_limit_reached' });
  });

  it('em produção o PSP falha fechado (sem simular sucesso)', async () => {
    const w = await orgWithoutPlan();
    const prevMode = process.env.PSP_MODE; const prevEnv = process.env.NODE_ENV;
    process.env.PSP_MODE = 'none';
    try {
      await expect(billing.startSubscription(w.org.user.id, w.orgId, { planId: 'profissional', period: 'monthly', acceptContract: true })).rejects.toMatchObject({ code: 'psp_not_configured', status: 503 });
    } finally { process.env.PSP_MODE = prevMode; (process.env as any).NODE_ENV = prevEnv; }
  });
});

describe('privacidade (AC14, AC15, AC21)', () => {
  it('AC14: exclusão com retenção necessária — decisão fundamentada, minimização e acesso encerrado', async () => {
    const w = await makeWorld();
    const p = await newUser('Paciente Que Sai');
    const a = await B.bookAppointment(p.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    const req = await privacy.createPrivacyRequest(p.id, 'erasure', 'Quero excluir meus dados');
    expect(req.protocol).toMatch(/^PV-/);
    const adm = await makeAdmin('security_admin');
    // executar antes de decidir => bloqueado
    await expect(privacy.executeErasure(adm.user.id, req.id)).rejects.toMatchObject({ code: 'decision_required' });
    // consulta futura ativa impede a execução
    await expect(privacy.resolvePrivacyRequest(adm.user.id, req.id, { status: 'partially_fulfilled', decision: 'curto', retainedCategories: [] })).rejects.toMatchObject({ status: 400 });
    await privacy.resolvePrivacyRequest(adm.user.id, req.id, {
      status: 'partially_fulfilled', decision: 'Eliminados dados de identificação; retidos registros administrativos de agenda sem identificação direta (fundamento a confirmar pelo jurídico).',
      retainedCategories: ['registro administrativo de agenda'],
    });
    await expect(privacy.executeErasure(adm.user.id, req.id)).rejects.toMatchObject({ code: 'active_appointments' });
    await B.cancelAppointment(p.id, a.body.id, 'saindo');
    await privacy.executeErasure(adm.user.id, req.id);
    const u = await one<any>('SELECT email, full_name, status, phone FROM users WHERE id=$1', [p.id]);
    expect(u.status).toBe('deleted');
    expect(u.full_name).toBe('Titular removido');
    expect(u.email).toContain('@invalid.local');
    const op = await one<any>('SELECT full_name, phone, email, anonymized_at FROM organization_patients WHERE id=(SELECT organization_patient_id FROM appointments WHERE id=$1)', [a.body.id]);
    expect(op.full_name).toBe('Titular removido');
    expect(op.anonymized_at).toBeTruthy();
    expect(await count('SELECT count(*) n FROM appointments WHERE id=$1', [a.body.id])).toBe(1); // registro administrativo retido
    const { login } = await import('../src/server/modules/identity');
    await expect(login({ email: p.email, password: p.password })).rejects.toMatchObject({ status: 401 });
    const rq = await one<any>('SELECT status, retained_categories, decision FROM privacy_requests WHERE id=$1', [req.id]);
    expect(rq.status).toBe('partially_fulfilled');
    expect(rq.retained_categories).toContain('registro administrativo de agenda');
    expect(rq.decision.length).toBeGreaterThan(20);
  });

  it('prazo por tipo de direito vem de configuração; exportação traz somente dados do próprio titular', async () => {
    const w = await makeWorld();
    const p1 = await newUser('Titular Um'), p2 = await newUser('Titular Dois');
    await B.bookAppointment(p1.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await B.bookAppointment(p2.id, { offeringId: w.offeringId, startsAt: w.slots[1].startsAt, payerType: 'private' });
    const r = await privacy.createPrivacyRequest(p1.id, 'portability');
    expect(new Date(r.dueAt).getTime()).toBeGreaterThan(Date.now());
    const exp = await privacy.exportMyData(p1.id);
    expect(exp.appointments.length).toBe(1);
    expect(JSON.stringify(exp)).not.toContain('Titular Dois');
    expect((exp.user as any).email).toBe(p1.email);
  });

  it('consentimentos nunca vêm pré-marcados e recusar não bloqueia recursos', async () => {
    const u = await newUser();
    expect(await privacy.currentConsents(u.id)).toEqual({ marketing: false, geolocation: false, push: false, whatsapp: false });
    await privacy.setConsent(u.id, 'marketing', true);
    await privacy.setConsent(u.id, 'marketing', false);
    expect((await privacy.currentConsents(u.id)).marketing).toBe(false);
    expect(await count("SELECT count(*) n FROM consent_events WHERE user_id=$1", [u.id])).toBe(2); // histórico preservado
  });

  it('AC21: CPF/telefone repetido não funde contas nem pacientes', async () => {
    const w = await makeWorld();
    const { createManualAppointment } = await import('../src/server/modules/booking');
    const a = await createManualAppointment(w.org.user.id, w.orgId, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, source: 'phone', patient: { fullName: 'Maria Souza', phone: '11999990000' } });
    const b = await createManualAppointment(w.org.user.id, w.orgId, { offeringId: w.offeringId, startsAt: w.slots[1].startsAt, source: 'phone', patient: { fullName: 'Maria Souza', phone: '11999990000' } });
    expect(a.organizationPatientId).not.toBe(b.organizationPatientId); // nada de fusão automática por nome/telefone
    const u1 = await newUser(), u2 = await newUser();
    await query('UPDATE users SET phone=$1 WHERE id IN ($2,$3)', ['11988887777', u1.id, u2.id]);
    expect(await count("SELECT count(*) n FROM users WHERE phone='11988887777'")).toBe(2);
    expect(await count('SELECT count(*) n FROM patient_account_links WHERE organization_patient_id IN ($1,$2)', [a.organizationPatientId, b.organizationPatientId])).toBe(0); // sem vínculo sem verificação
  });
});

describe('feedback privado (AC18) e moderação', () => {
  it('só consulta concluída; conteúdo com diagnóstico/dado de terceiro é sinalizado e nunca publicado', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await expect(quality.submitFeedback(u.id, a.body.id, { punctuality: 5, communication: 5, structure: 5 })).rejects.toMatchObject({ code: 'not_completed' });
    await query("UPDATE appointments SET starts_at = now() - interval '2 hours', ends_at = now() - interval '90 minutes' WHERE id=$1", [a.body.id]);
    await B.closeAppointment(w.org.user.id, a.body.id, 'completed');
    const f1 = await quality.submitFeedback(u.id, a.body.id, { punctuality: 4, communication: 5, structure: 5, comment: 'Fui atendido no horário.' });
    expect(f1.flagged).toBe(false);
    expect(f1.visibility).toBe('private');
    const f2 = await quality.submitFeedback(u.id, a.body.id, { punctuality: 4, communication: 5, structure: 5, comment: 'Meu diagnóstico é câncer, minha esposa Ana 123.456.789-09 também vai.' });
    expect(f2.flagged).toBe(true);
    expect(f2.revision).toBe(2); // correção com rastreio
    const row = await one<any>('SELECT visibility, moderation_status FROM feedback WHERE appointment_id=$1', [a.body.id]);
    expect(row.visibility).toBe('private');
    expect(row.moderation_status).toBe('flagged');
    expect(await count("SELECT count(*) n FROM moderation_cases WHERE subject_type='feedback' AND subject_id=(SELECT id FROM feedback WHERE appointment_id=$1)", [a.body.id])).toBe(1);
    // o banco recusa publicação
    await expect(pool().query("UPDATE feedback SET visibility='published' WHERE appointment_id=$1", [a.body.id])).rejects.toThrow(/check constraint/i);
    // painel: sem comentário e com supressão de grupo pequeno
    const sum = await quality.feedbackSummary(w.org.user.id, w.orgId);
    expect(sum.suppressed).toBe(true);
    expect(JSON.stringify(sum)).not.toContain('câncer');
    // busca pública não expõe nota
    const s = await searchPractitioners({ city: (await one<any>('SELECT city FROM locations WHERE id=$1', [w.locationId])).city });
    expect(JSON.stringify(s)).not.toMatch(/punctuality|rating|nota/i);
    // outro paciente não avalia consulta alheia
    const other = await newUser();
    await expect(quality.submitFeedback(other.id, a.body.id, { punctuality: 1, communication: 1, structure: 1 })).rejects.toMatchObject({ status: 404 });
  });
});

describe('métricas e exportações', () => {
  it('fórmulas: falta = no_show/(completed+no_show); ocupação por minutos; período e fuso informados', async () => {
    const w = await makeWorld();
    const users = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    const appts = [];
    for (let i = 0; i < 4; i++) appts.push(await B.bookAppointment(users[i].id, { offeringId: w.offeringId, startsAt: w.slots[i].startsAt, payerType: 'private' }));
    // 3 no passado: 2 concluídas + 1 falta; 1 futura (não entra na taxa)
    for (let i = 0; i < 3; i++) await query("UPDATE appointments SET starts_at = now() - interval '1 day' - make_interval(hours => $2::int), ends_at = now() - interval '1 day' - make_interval(hours => $2::int) + interval '30 minutes' WHERE id=$1", [appts[i].body.id, i]);
    await B.closeAppointment(w.org.user.id, appts[0].body.id, 'completed');
    await B.closeAppointment(w.org.user.id, appts[1].body.id, 'completed');
    await B.closeAppointment(w.org.user.id, appts[2].body.id, 'no_show');
    const from = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10), to = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    const m = await reports.orgMetrics(w.org.user.id, w.orgId, from, to);
    expect(m.completed).toBe(2);
    expect(m.noShow).toBe(1);
    expect(m.noShowRate).toBeCloseTo(1 / 3, 3);
    expect(m.period.timezone).toBe('America/Sao_Paulo');
    expect(m.occupancy).toBeGreaterThan(0);
    expect(m.occupancy).toBeLessThan(1);
    expect(m.newPatients).toBe(2);
    expect(m.scheduled).toBe(1);
  });

  it('MRR normaliza anual/12, exclui teste e não inclui valor das consultas', async () => {
    const admin = await makeAdmin('platform_admin');
    const before = (await reports.adminMetrics(admin.user.id)).mrrCents;
    const a = await makeWorld({ plan: null }), b = await makeWorld({ plan: null }), c = await makeWorld({ plan: null });
    const mk = (orgId: string, planId: string, period: string, status: string, amount: number) => pool().query(
      `INSERT INTO subscriptions(organization_id, plan_version_id, billing_period, status, amount_cents, trial_ends_at, current_period_end) VALUES ($1,(SELECT id FROM plan_versions WHERE plan_id=$2 AND version=1),$3,$4,$5, now() + interval '5 days', now() + interval '20 days')`, [orgId, planId, period, status, amount]);
    await mk(a.orgId, 'essencial', 'monthly', 'active', 6900);
    await mk(b.orgId, 'profissional', 'yearly', 'active', 129000);
    await mk(c.orgId, 'clinica', 'monthly', 'trialing', 24900);
    const m = await reports.adminMetrics(admin.user.id);
    expect(m.mrrCents - before).toBe(6900 + 10750); // anual/12 = 10750; teste não conta
    expect(m.trialing).toBeGreaterThanOrEqual(1);
    const r = await call(metricsRoute.GET, { cookie: admin.cookie });
    expect(r.status).toBe(200);
    const denied = await call(metricsRoute.GET, { cookie: (await patientSession()).cookie });
    expect(denied.status).toBe(403);
  });

  it('AC22: exportação mantém o escopo do pedido e revalida o acesso na execução; arquivo é privado', async () => {
    const w = await makeWorld({ plan: 'clinica' });
    const other = await makeWorld();
    const p = await newUser('Paciente Exportado');
    await B.bookAppointment(p.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    const from = new Date().toISOString(), to = new Date(Date.now() + 30 * 86400_000).toISOString();
    // gestor de outra organização não pode pedir exportação desta
    await expect(reports.requestExport(other.org.user.id, w.orgId, from, to)).rejects.toMatchObject({ status: 403 });
    const ok = await reports.requestExport(w.org.user.id, w.orgId, from, to);
    await reports.processExports();
    const csv = await reports.downloadExport(w.org.user.id, w.orgId, ok.id);
    expect(csv).toContain('Paciente Exportado');
    const file = (await one<any>('SELECT file_path FROM data_exports WHERE id=$1', [ok.id])).file_path;
    expect(fs.statSync(file).mode & 0o077).toBe(0); // sem acesso a grupo/outros
    await expect(reports.downloadExport(other.org.user.id, w.orgId, ok.id)).rejects.toMatchObject({ status: 403 });
    // pedido feito, e ANTES da execução o solicitante perde o acesso (removido da equipe)
    const second = await reports.requestExport(w.org.user.id, w.orgId, from, to);
    await pool().query("UPDATE memberships SET status='removed' WHERE user_id=$1 AND organization_id=$2", [w.org.user.id, w.orgId]);
    await reports.processExports();
    const d = await one<any>('SELECT status, file_path FROM data_exports WHERE id=$1', [second.id]);
    expect(d.status).toBe('denied');
    expect(d.file_path).toBeNull();
    // expiração
    await pool().query("UPDATE data_exports SET expires_at = now() - interval '1 minute' WHERE id=$1", [ok.id]);
    await pool().query("UPDATE memberships SET status='active' WHERE user_id=$1 AND organization_id=$2", [w.org.user.id, w.orgId]);
    await expect(reports.downloadExport(w.org.user.id, w.orgId, ok.id)).rejects.toMatchObject({ status: 410 });
    expect(await count("SELECT count(*) n FROM audit_events WHERE action IN ('export.requested','export.generated','export.denied','export.downloaded') AND organization_id=$1", [w.orgId])).toBeGreaterThanOrEqual(4);
    void authorizeOrg;
  });

  it('exportação neutraliza injeção de fórmula em CSV', async () => {
    const w = await makeWorld({ plan: 'clinica' });
    const { createManualAppointment } = await import('../src/server/modules/booking');
    await createManualAppointment(w.org.user.id, w.orgId, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, source: 'reception', patient: { fullName: '=HYPERLINK("http://x")' } });
    const e = await reports.requestExport(w.org.user.id, w.orgId, new Date().toISOString(), new Date(Date.now() + 30 * 86400_000).toISOString());
    await reports.processExports();
    const csv = await reports.downloadExport(w.org.user.id, w.orgId, e.id);
    expect(csv).toContain(`"'=HYPERLINK`);
  });
});

describe('incidentes e auditoria', () => {
  it('relógio de 3 dias úteis a partir da ciência; só quem gere incidentes acessa', async () => {
    const adm = await makeAdmin('security_admin');
    // sexta 2026-01-02 => 3 dias úteis = quarta 2026-01-07 (data passada: o prazo já venceu)
    const r = await incidents.createIncident(adm.user.id, { title: 'Acesso indevido (teste)', severity: 'high', detectedAt: '2026-01-02T13:00:00.000Z', awarenessAt: '2026-01-02T13:00:00.000Z', affectsPersonalData: true });
    expect(new Date(r.communicationDueAt!).toISOString().slice(0, 10)).toBe('2026-01-07');
    const none = await incidents.createIncident(adm.user.id, { title: 'Indisponibilidade (teste)', severity: 'low', detectedAt: '2026-01-02T13:00:00.000Z', awarenessAt: '2026-01-02T13:00:00.000Z', affectsPersonalData: false });
    expect(none.communicationDueAt).toBeNull();
    await incidents.advanceIncident(adm.user.id, r.id, 'contained', 'contido');
    const list = await incidents.listIncidents(adm.user.id);
    expect(list.find((i: any) => i.id === r.id).overdue).toBe(true);
    const pat = await newUser();
    await expect(incidents.listIncidents(pat.id)).rejects.toMatchObject({ status: 403 });
    const sup = await makeAdmin('support');
    await expect(incidents.listAudit(sup.user.id)).rejects.toMatchObject({ status: 403 });
    const rows = await incidents.listAudit(adm.user.id, { action: 'incident.created' });
    expect(rows.length).toBeGreaterThan(0);
    expect(await count("SELECT count(*) n FROM audit_events WHERE action='audit.viewed'")).toBeGreaterThan(0); // consulta à auditoria também é auditada
  });

  it('suporte não tem "entrar como paciente": sem endpoint e o grant exige motivo/ticket/aprovador distinto', async () => {
    await expect(pool().query(`INSERT INTO support_access_grants(granted_to, subject_type, subject_id, ticket_ref, reason, approved_by, expires_at) VALUES ($1,'user',gen_random_uuid(),'T-1','x',$1, now() + interval '1 hour')`, [(await newUser()).id])).rejects.toThrow(/check constraint/i);
  });
});

describe('documentos legais e aceites', () => {
  it('minutas ficam marcadas e não podem ser publicadas sem aprovador humano', async () => {
    const r = await call(legalRoute.GET, { params: { key: 'termos-paciente' } });
    expect(r.status).toBe(200);
    expect(r.data.isDraft).toBe(true);
    expect(r.data.body).toContain('MINUTA — REVISÃO JURÍDICA PENDENTE');
    await expect(pool().query("UPDATE document_versions SET status='published' WHERE status='draft_minuta'")).rejects.toThrow(/check constraint/i);
    // produção: sem versão publicada => cadastro é bloqueado
    const prev = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'production';
    try {
      const { currentVersion } = await import('../src/server/modules/documents');
      await expect(currentVersion('termos-paciente')).rejects.toMatchObject({ code: 'document_not_published' });
    } finally { (process.env as any).NODE_ENV = prev; }
    expect(sessionFor).toBeTruthy();
  });
});
