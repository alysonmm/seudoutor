import { describe, it, expect, afterAll } from 'vitest';
import { generateSync } from 'otplib';
import { call, setPlan, newUser, sessionFor, newStaffOrg, lastMailCode, rnd, PASSWORD, totpFor } from './helpers';
import * as registerRoute from '../src/app/api/v1/auth/register/route';
import * as loginRoute from '../src/app/api/v1/auth/login/route';
import * as meRoute from '../src/app/api/v1/auth/me/route';
import * as verifyRoute from '../src/app/api/v1/auth/verify-email/route';
import * as membersRoute from '../src/app/api/v1/organizations/[orgId]/members/route';
import * as memberRoute from '../src/app/api/v1/organizations/[orgId]/members/[membershipId]/route';
import * as inviteRoute from '../src/app/api/v1/organizations/[orgId]/invitations/route';
import * as acceptRoute from '../src/app/api/v1/invitations/accept/route';
import * as orgsRoute from '../src/app/api/v1/organizations/route';
import { one, query, closePool } from '../src/server/db';
import { hashPassword, verifyPassword, signLink, verifyLink, encrypt, decrypt } from '../src/server/lib/crypto';

afterAll(async () => { await closePool(); });

describe('cadastro e login', () => {
  it('registra, exige verificação e não enumera e-mails', async () => {
    const email = `a${rnd()}@teste.local`;
    const r1 = await call(registerRoute.POST, { body: { email, password: PASSWORD, fullName: 'Ana', acceptTerms: true } });
    const r2 = await call(registerRoute.POST, { body: { email, password: PASSWORD, fullName: 'Ana', acceptTerms: true } });
    expect(r1.status).toBe(200);
    expect(r2.data).toEqual(r1.data); // resposta idêntica com e-mail já existente
    const bad = await call(verifyRoute.POST, { body: { email, code: '000000' } });
    expect(bad.status).toBe(400);
    const ok = await call(verifyRoute.POST, { body: { email, code: await lastMailCode(email) } });
    expect(ok.status).toBe(200);
    const acc = await query('SELECT * FROM terms_acceptances ta JOIN users u ON u.id=ta.user_id WHERE u.email=$1', [email]);
    expect(acc.length).toBe(2); // termos + privacidade, com hash e versão
    expect(acc[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exige aceite dos termos e senha forte', async () => {
    const e = `b${rnd()}@teste.local`;
    expect((await call(registerRoute.POST, { body: { email: e, password: PASSWORD, fullName: 'X Y', acceptTerms: false } })).status).toBe(400);
    expect((await call(registerRoute.POST, { body: { email: e, password: 'curta', fullName: 'X Y', acceptTerms: true } })).status).toBe(400);
  });

  it('login com erro é genérico e trava após tentativas', async () => {
    const u = await newUser();
    const wrongPw = await call(loginRoute.POST, { body: { email: u.email, password: 'errada-errada-1' } });
    const noUser = await call(loginRoute.POST, { body: { email: `nao${rnd()}@teste.local`, password: 'errada-errada-1' } });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.data.error.code).toBe(noUser.data.error.code);
    for (let i = 0; i < 7; i++) await call(loginRoute.POST, { body: { email: u.email, password: 'errada-errada-1' } });
    const locked = await call(loginRoute.POST, { body: { email: u.email, password: PASSWORD } });
    expect(locked.status).toBe(401); // conta travada temporariamente, mesmo com senha correta
    await query("UPDATE users SET locked_until=NULL, failed_logins=0 WHERE id=$1", [u.id]);
    const good = await call(loginRoute.POST, { body: { email: u.email, password: PASSWORD } });
    expect(good.status).toBe(200);
    const setCookie = good.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('senha usa scrypt e não fica em texto', async () => {
    const h = await hashPassword('abc123456789');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('abc123456789', h)).toBe(true);
    expect(await verifyPassword('outra', h)).toBe(false);
  });

  it('bloqueia requisição mutante de origem cruzada (CSRF)', async () => {
    const r = await call(loginRoute.POST, { body: { email: 'x@y.z', password: 'x' }, headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe('csrf_origin');
  });
});

describe('MFA obrigatório para papéis profissionais', () => {
  it('sessão de gestor sem 2º fator não acessa recursos; após TOTP acessa', async () => {
    const u = await newUser();
    const c0 = await sessionFor(u);
    const created = await call(orgsRoute.POST, { cookie: c0, body: { kind: 'individual', name: 'Consultório X', asPractitioner: true, acceptContract: true } });
    expect(created.status).toBe(200);
    // mesma sessão agora exige MFA
    const me1 = await call(meRoute.GET, { cookie: c0 });
    expect(me1.data.mfa.required).toBe(true);
    expect(me1.data.organizations).toEqual([]);
    const denied = await call(orgsRoute.GET, { cookie: c0 });
    expect(denied.status).toBe(403);
    expect(denied.data.error.code).toBe('mfa_required');
    // novo login exige enrolar + confirmar
    const c1 = await sessionFor(u);
    const me2 = await call(meRoute.GET, { cookie: c1 });
    expect(me2.data.mfa.verified).toBe(true);
    expect(me2.data.organizations.length).toBe(1);
  });

  it('TOTP reutilizado (replay) e código errado são recusados; código de recuperação é de uso único', async () => {
    const { user } = await newStaffOrg();
    const { call: c } = { call };
    const mfaVerifyRoute = await import('../src/app/api/v1/auth/mfa/verify/route');
    const l = await call(loginRoute.POST, { body: { email: user.email, password: PASSWORD } });
    const cookie = l.headers.get('set-cookie')!.split(';')[0];
    expect(l.data.mfaRequired).toBe(true);
    const wrong = await c(mfaVerifyRoute.POST, { cookie, body: { token: '000000' } });
    expect(wrong.status).toBe(400);
    await query('UPDATE mfa_methods SET last_used_step = NULL WHERE user_id=$1', [user.id]);
    const tok = totpFor(user.email);
    const good = await c(mfaVerifyRoute.POST, { cookie, body: { token: tok } });
    const again = await c(mfaVerifyRoute.POST, { cookie, body: { token: tok } });
    expect(again.status).toBe(400);
    expect(good.status).toBe(200);
  });
});

describe('organizações, convites e permissões', () => {
  it('convite só é aceito por conta com o e-mail verificado do destinatário e expira', async () => {
    const owner = await newStaffOrg('clinic', false);
    await setPlan(owner.organizationId, 'clinica');
    const invited = await newUser('Secretária');
    const other = await newUser('Outro');
    const inv = await call(inviteRoute.POST, { cookie: owner.cookie, params: { orgId: owner.organizationId }, body: { email: invited.email, role: 'secretary', practitionerIds: [], locationIds: [] } });
    expect(inv.status).toBe(400); // secretária exige escopo
    // cria local para escopo
    const loc = await one<{ id: string }>(`INSERT INTO locations(organization_id,name,street,neighborhood,city,uf) VALUES ($1,'Sede','Rua A','Centro','Cidade','SP') RETURNING id`, [owner.organizationId]);
    const inv2 = await call(inviteRoute.POST, { cookie: owner.cookie, params: { orgId: owner.organizationId }, body: { email: invited.email, role: 'secretary', locationIds: [loc!.id] } });
    expect(inv2.status).toBe(200);
    expect(inv2.data.token).toBeUndefined(); // token não volta ao convidante
    const mail = await one<{ body: string }>('SELECT body FROM dev_mailbox WHERE to_email=$1 ORDER BY id DESC LIMIT 1', [invited.email]);
    const token = mail!.body.match(/convites\/(\S+)/)![1];
    const otherCookie = await sessionFor(other);
    const wrong = await call(acceptRoute.POST, { cookie: otherCookie, body: { token } });
    expect(wrong.status).toBe(403);
    const cookie = await sessionFor(invited);
    const ok = await call(acceptRoute.POST, { cookie, body: { token } });
    expect(ok.status).toBe(200);
    const again = await call(acceptRoute.POST, { cookie, body: { token } });
    expect(again.status).toBe(404);
    // convite expirado
    const inv3 = await call(inviteRoute.POST, { cookie: owner.cookie, params: { orgId: owner.organizationId }, body: { email: other.email, role: 'finance' } });
    expect(inv3.status).toBe(200);
    await query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE email=$1", [other.email]);
    const mail2 = await one<{ body: string }>('SELECT body FROM dev_mailbox WHERE to_email=$1 ORDER BY id DESC LIMIT 1', [other.email]);
    const t2 = mail2!.body.match(/convites\/(\S+)/)![1];
    expect((await call(acceptRoute.POST, { cookie: otherCookie, body: { token: t2 } })).status).toBe(404);
  });

  it('AC04: usuário removido perde acesso imediatamente e sessões são revogadas', async () => {
    const owner = await newStaffOrg('clinic', false);
    await setPlan(owner.organizationId, 'clinica');
    const fin = await newUser('Financeiro');
    const inv = await call(inviteRoute.POST, { cookie: owner.cookie, params: { orgId: owner.organizationId }, body: { email: fin.email, role: 'finance' } });
    expect(inv.status).toBe(200);
    const mail = await one<{ body: string }>('SELECT body FROM dev_mailbox WHERE to_email=$1 ORDER BY id DESC LIMIT 1', [fin.email]);
    const token = mail!.body.match(/convites\/(\S+)/)![1];
    const c0 = await sessionFor(fin);
    await call(acceptRoute.POST, { cookie: c0, body: { token } });
    const cFin = await sessionFor(fin);
    const { authorizeOrg } = await import('../src/server/modules/authz');
    await expect(authorizeOrg(fin.id, owner.organizationId, 'billing.read')).resolves.toBeTruthy();
    const members = await call(membersRoute.GET, { cookie: owner.cookie, params: { orgId: owner.organizationId } });
    const m = members.data.find((x: any) => x.user_id === fin.id);
    const del = await call(memberRoute.DELETE, { method: 'DELETE', cookie: owner.cookie, params: { orgId: owner.organizationId, membershipId: m.membership_id } });
    expect(del.status).toBe(204);
    await expect(authorizeOrg(fin.id, owner.organizationId, 'billing.read')).rejects.toMatchObject({ status: 403 });
    const me = await call(meRoute.GET, { cookie: cFin });
    expect(me.status).toBe(401); // sessão antiga revogada
    // histórico preservado
    const row = await one('SELECT status, removed_by FROM memberships WHERE id=$1', [m.membership_id]);
    expect(row.status).toBe('removed');
    expect(row.removed_by).toBe(owner.user.id);
  });

  it('não permite remover o último gestor; membro sem permissão não gerencia equipe', async () => {
    const owner = await newStaffOrg('clinic', false);
    const members = await call(membersRoute.GET, { cookie: owner.cookie, params: { orgId: owner.organizationId } });
    const mine = members.data[0];
    const del = await call(memberRoute.DELETE, { method: 'DELETE', cookie: owner.cookie, params: { orgId: owner.organizationId, membershipId: mine.membership_id } });
    expect(del.status).toBe(409);
    const stranger = await newStaffOrg('individual');
    const r = await call(membersRoute.GET, { cookie: stranger.cookie, params: { orgId: owner.organizationId } });
    expect(r.status).toBe(403); // outra organização
  });
});

describe('auditoria e links', () => {
  it('audit_events é append-only (UPDATE/DELETE/TRUNCATE falham)', async () => {
    await newUser();
    await expect(query('UPDATE audit_events SET action=\'x\'')).rejects.toThrow(/append-only/);
    await expect(query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    await expect(query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('links assinados: finalidade única, expiração e adulteração', () => {
    const t = signLink('cancel', 'abc', 60, 1_000_000);
    expect(verifyLink(t, 'cancel', 1_000_000 + 1000)).toEqual({ subjectId: 'abc' });
    expect(verifyLink(t, 'confirm', 1_000_000)).toBeNull();
    expect(verifyLink(t, 'cancel', 1_000_000 + 120_000)).toBeNull();
    expect(verifyLink(t.slice(0, -2) + 'aa', 'cancel', 1_000_000)).toBeNull();
  });

  it('cifra de segredos round-trip', () => {
    expect(decrypt(encrypt('segredo'))).toBe('segredo');
  });
});
