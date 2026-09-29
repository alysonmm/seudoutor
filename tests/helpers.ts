import crypto from 'node:crypto';
import { generateSync } from 'otplib';
import { one, query, pool } from '../src/server/db';
import { register, verifyEmail, login } from '../src/server/modules/identity';

export const rnd = () => crypto.randomBytes(4).toString('hex');
export const PASSWORD = 'Senha-Forte-123!';
const mfaSecrets = new Map<string, string>();

type RouteFn = (req: Request, ctx?: any) => Promise<Response>;

export async function call(fn: RouteFn, opts: {
  method?: string; url?: string; body?: unknown; cookie?: string; params?: Record<string, string>; headers?: Record<string, string>; rawBody?: string;
} = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  if (hasBody) headers['content-type'] = 'application/json';
  const req = new Request(opts.url ?? 'http://localhost:3000/api/test', {
    method: opts.method ?? (hasBody ? 'POST' : 'GET'), headers,
    body: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const res = await fn(req, { params: Promise.resolve(opts.params ?? {}) });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

export async function lastMailCode(email: string): Promise<string> {
  const r = await one<{ body: string }>("SELECT body FROM dev_mailbox WHERE to_email=$1 AND body LIKE '%código é%' ORDER BY id DESC LIMIT 1", [email]);
  const m = r?.body.match(/código é (\d{6})/);
  if (!m) throw new Error('sem código no dev_mailbox');
  return m[1];
}

export interface TestUser { id: string; email: string; password: string; fullName: string }

/** Cria usuário paciente com e-mail verificado (via fluxo real de módulo). */
export async function newUser(name = 'Usuário Teste'): Promise<TestUser> {
  const email = `u${rnd()}${rnd()}@teste.local`;
  await register({ email, password: PASSWORD, fullName: name, acceptTerms: true, ip: `ip-${rnd()}` });
  await verifyEmail({ email, code: await lastMailCode(email) });
  const u = await one<{ id: string }>('SELECT id FROM users WHERE email=$1', [email]);
  return { id: u!.id, email, password: PASSWORD, fullName: name };
}

/** Faz login e, se exigido, conclui MFA (cadastrando TOTP na primeira vez). Retorna cabeçalho Cookie. */
export async function sessionFor(u: TestUser): Promise<string> {
  const l = await login({ email: u.email, password: u.password, ip: `ip-${rnd()}` });
  const cookie = `sid=${encodeURIComponent(l.token)}`;
  if (!l.mfaRequired) return cookie;
  const { mfaBeginEnrollment, mfaConfirmEnrollment, mfaVerify, resolveSession } = await import('../src/server/modules/identity');
  const s = (await resolveSession(l.token))!;
  if (!l.mfaEnrolled) {
    const e = await mfaBeginEnrollment(u.id, u.email);
    mfaSecrets.set(u.email, e.secret);
    await mfaConfirmEnrollment(u.id, s.sessionId, generateSync({ secret: e.secret }));
  } else {
    await freshTotpWindow();
    await mfaVerify(u.id, s.sessionId, { token: generateSync({ secret: mfaSecrets.get(u.email)! }) });
  }
  return cookie;
}
/** Evita reaproveitar o mesmo passo TOTP (anti-replay) em logins consecutivos do teste. */
async function freshTotpWindow() {
  await pool().query('UPDATE mfa_methods SET last_used_step = NULL');
}
export const totpFor = (email: string) => generateSync({ secret: mfaSecrets.get(email)! });

export async function newStaffOrg(kind: 'individual' | 'clinic' = 'individual', asPractitioner = true) {
  const u = await newUser('Dra. Teste ' + rnd());
  const c1 = await sessionFor(u);
  const { createOrganization } = await import('../src/server/modules/orgs');
  const org = await createOrganization(u.id, { kind, name: 'Consultório ' + rnd(), asPractitioner, acceptContract: true });
  const cookie = await sessionFor(u); // agora com MFA
  return { user: u, cookie, ...org, c1 };
}

export async function count(sql: string, params: unknown[] = []) {
  return Number((await query<{ n: string }>(sql, params))[0].n);
}

/** Ativa uma assinatura de teste diretamente (o fluxo real de checkout é testado na Etapa 4). */
export async function setPlan(organizationId: string, planId: 'essencial' | 'profissional' | 'clinica' = 'clinica', status = 'active') {
  const pv = await one<{ id: string; price_monthly_cents: number }>('SELECT id, price_monthly_cents FROM plan_versions WHERE plan_id=$1 ORDER BY version DESC LIMIT 1', [planId]);
  await pool().query("DELETE FROM subscriptions WHERE organization_id=$1", [organizationId]);
  await pool().query(
    `INSERT INTO subscriptions(organization_id, plan_version_id, billing_period, status, trial_ends_at, current_period_start, current_period_end, amount_cents)
     VALUES ($1,$2,'monthly',$3, now() + interval '14 days', now(), now() + interval '30 days', $4)`, [organizationId, pv!.id, status, pv!.price_monthly_cents]);
}
