import { z } from 'zod';
import { one, query, withTx, pool, type Db } from '../db';
import { audit } from '../lib/audit';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors';
import { hashPassword, verifyPassword, DUMMY_HASH_PROMISE, randomToken, sha256, hmacHex, randomDigits, encrypt, decrypt, safeEqualHex } from '../lib/crypto';
import { rateLimit } from '../lib/rate-limit';
import { sendEmail } from '../lib/email';
import { config } from '../config';
import { recordAcceptance } from './documents';
import { generateSecret, generateURI, verifySync } from 'otplib';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_FAILED = 8;

export const passwordSchema = z.string().min(10, 'Senha com pelo menos 10 caracteres').max(128);
export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export interface SessionInfo {
  sessionId: string;
  userId: string;
  mfaVerified: boolean;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  user: { id: string; email: string; full_name: string; email_verified_at: string | null };
}

// ---------------- Cadastro e verificação de contato ----------------
function codeHash(code: string, dest: string) { return hmacHex(config.linkSecret, `${dest}:${code}`); }

export async function issueContactCode(db: Db, userId: string | null, email: string, purpose: 'verify_contact' | 'reset_password') {
  const code = randomDigits(6);
  await db.query(
    `INSERT INTO contact_verifications(user_id, channel, destination, purpose, code_hash, expires_at)
     VALUES ($1,'email',$2,$3,$4,$5)`,
    [userId, email, purpose, codeHash(code, email), new Date(Date.now() + CODE_TTL_MS)]);
  await sendEmail({
    to: email,
    subject: purpose === 'verify_contact' ? 'Seu código de verificação' : 'Recuperação de acesso',
    body: `Seu código é ${code}. Ele expira em 15 minutos. Se você não solicitou, ignore esta mensagem.`,
  }, db);
}

/** Resposta idêntica exista o e-mail ou não (sem enumeração). */
export async function register(input: { email: string; password: string; fullName: string; phone?: string; acceptTerms: boolean; ip?: string }) {
  if (!input.acceptTerms) throw badRequest('terms_required', 'É necessário aceitar os Termos e ler o Aviso de Privacidade');
  const email = emailSchema.parse(input.email);
  passwordSchema.parse(input.password);
  const fullName = z.string().trim().min(2).max(120).parse(input.fullName);
  await rateLimit(`register:${input.ip ?? 'na'}`, 20, 3600);
  const existing = await one('SELECT id FROM users WHERE email=$1', [email]);
  if (existing) {
    // não revela; avisa o titular do e-mail
    await sendEmail({ to: email, subject: 'Tentativa de cadastro', body: 'Alguém tentou criar uma conta com este e-mail, que já possui cadastro. Se foi você, use "Recuperar acesso".' });
    await hashPassword(input.password); // equaliza custo
    return { status: 'verification_sent' as const };
  }
  const hash = await hashPassword(input.password);
  await withTx(async (tx) => {
    const u = await one<{ id: string }>(
      `INSERT INTO users(email, password_hash, full_name, phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, hash, fullName, input.phone ?? null], tx);
    await tx.query('INSERT INTO patient_accounts(user_id) VALUES ($1)', [u!.id]);
    await recordAcceptance(tx, u!.id, 'termos-paciente', null, { via: 'cadastro' });
    await recordAcceptance(tx, u!.id, 'aviso-privacidade', null, { via: 'cadastro' });
    await issueContactCode(tx, u!.id, email, 'verify_contact');
    await audit({ actorUserId: u!.id, action: 'user.registered', objectType: 'user', objectId: u!.id }, tx);
  });
  return { status: 'verification_sent' as const };
}

async function consumeCode(email: string, purpose: 'verify_contact' | 'reset_password', code: string): Promise<string | null> {
  return withTx(async (tx) => {
    const row = await one<{ id: string; code_hash: string; attempts: number; user_id: string | null }>(
      `SELECT id, code_hash, attempts, user_id FROM contact_verifications
        WHERE destination=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [email, purpose], tx);
    if (!row) return null;
    if (row.attempts >= 5) return null;
    if (!safeEqualHex(row.code_hash, codeHash(code, email))) {
      await tx.query('UPDATE contact_verifications SET attempts = attempts + 1 WHERE id=$1', [row.id]);
      return null;
    }
    await tx.query('UPDATE contact_verifications SET consumed_at=now() WHERE id=$1', [row.id]);
    return row.user_id;
  });
}

export async function verifyEmail(input: { email: string; code: string; ip?: string }) {
  const email = emailSchema.parse(input.email);
  await rateLimit(`verify:${email}`, 10, 900);
  const userId = await consumeCode(email, 'verify_contact', input.code);
  if (!userId) throw badRequest('invalid_code', 'Código inválido ou expirado');
  await query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at=now() WHERE id=$1', [userId]);
  await audit({ actorUserId: userId, action: 'user.email_verified', objectType: 'user', objectId: userId });
  return { ok: true };
}

export async function requestPasswordReset(emailRaw: string, ip?: string) {
  const email = emailSchema.parse(emailRaw);
  await rateLimit(`reset:${email}`, 5, 3600);
  await rateLimit(`reset-ip:${ip ?? 'na'}`, 30, 3600);
  const u = await one<{ id: string }>("SELECT id FROM users WHERE email=$1 AND status <> 'deleted'", [email]);
  if (u) await issueContactCode(pool(), u.id, email, 'reset_password');
  return { status: 'sent_if_exists' as const };
}

export async function resetPassword(input: { email: string; code: string; newPassword: string }) {
  const email = emailSchema.parse(input.email);
  passwordSchema.parse(input.newPassword);
  await rateLimit(`resetpw:${email}`, 10, 900);
  const userId = await consumeCode(email, 'reset_password', input.code);
  if (!userId) throw badRequest('invalid_code', 'Código inválido ou expirado');
  const hash = await hashPassword(input.newPassword);
  await withTx(async (tx) => {
    await tx.query('UPDATE users SET password_hash=$2, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$1', [userId, hash]);
    await tx.query("UPDATE sessions SET revoked_at=now(), revoked_reason='password_reset' WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
    await audit({ actorUserId: userId, action: 'user.password_reset', objectType: 'user', objectId: userId }, tx);
  });
  // Observação: recuperar a senha NÃO contorna o MFA de quem o possui.
  return { ok: true };
}

// ---------------- Login, sessão, MFA ----------------
export async function userRequiresMfa(userId: string, db: Db = pool()): Promise<{ required: boolean; enrolled: boolean }> {
  const r = await one<{ staff: boolean; enrolled: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM memberships m JOIN roles r ON r.id = m.role_id
                      WHERE m.user_id=$1 AND m.status='active' AND r.requires_mfa)
             OR EXISTS (SELECT 1 FROM platform_staff s WHERE s.user_id=$1 AND s.status='active')) AS staff,
            EXISTS (SELECT 1 FROM mfa_methods WHERE user_id=$1 AND confirmed_at IS NOT NULL) AS enrolled`, [userId], db);
  return { required: !!r?.staff || !!r?.enrolled, enrolled: !!r?.enrolled };
}

export async function login(input: { email: string; password: string; ip?: string; userAgent?: string }) {
  const email = emailSchema.parse(input.email);
  await rateLimit(`login:${email}`, 10, 900);
  await rateLimit(`login-ip:${input.ip ?? 'na'}`, 60, 900);
  const u = await one<any>('SELECT * FROM users WHERE email=$1', [email]);
  const generic = unauthorized('invalid_credentials', 'E-mail ou senha inválidos');
  if (!u || u.status === 'deleted') { await verifyPassword(input.password, await DUMMY_HASH_PROMISE); throw generic; }
  if (u.locked_until && new Date(u.locked_until) > new Date()) { await verifyPassword(input.password, await DUMMY_HASH_PROMISE); throw generic; }
  const ok = await verifyPassword(input.password, u.password_hash);
  if (!ok) {
    const failed = u.failed_logins + 1;
    await query('UPDATE users SET failed_logins=$2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + interval \'15 minutes\' ELSE locked_until END WHERE id=$1', [u.id, failed, MAX_FAILED]);
    await audit({ actorKind: 'system', action: 'auth.login_failed', objectType: 'user', objectId: u.id });
    throw generic;
  }
  await query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
  const token = randomToken();
  await query(
    `INSERT INTO sessions(user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4)`,
    [u.id, sha256(token), new Date(Date.now() + SESSION_TTL_MS), (input.userAgent ?? '').slice(0, 200)]);
  await audit({ actorUserId: u.id, action: 'auth.login', objectType: 'user', objectId: u.id });
  const mfa = await userRequiresMfa(u.id);
  return { token, expiresAt: new Date(Date.now() + SESSION_TTL_MS), mfaRequired: mfa.required, mfaEnrolled: mfa.enrolled };
}

export async function resolveSession(token: string | undefined | null): Promise<SessionInfo | null> {
  if (!token) return null;
  const s = await one<any>(
    `SELECT s.id AS session_id, s.mfa_verified_at, u.id, u.email, u.full_name, u.email_verified_at, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(token)]);
  if (!s || s.status !== 'active') return null;
  const mfa = await userRequiresMfa(s.id);
  return {
    sessionId: s.session_id, userId: s.id, mfaVerified: !!s.mfa_verified_at, mfaRequired: mfa.required, mfaEnrolled: mfa.enrolled,
    user: { id: s.id, email: s.email, full_name: s.full_name, email_verified_at: s.email_verified_at },
  };
}

export async function logout(sessionId: string) {
  await query("UPDATE sessions SET revoked_at=now(), revoked_reason='logout' WHERE id=$1 AND revoked_at IS NULL", [sessionId]);
}
export async function revokeAllSessions(userId: string, reason: string, db: Db = pool()) {
  await db.query('UPDATE sessions SET revoked_at=now(), revoked_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL', [userId, reason]);
}

// MFA (TOTP). Segredo cifrado em repouso (AES-256-GCM). Anti-replay por passo de tempo.
export async function mfaBeginEnrollment(userId: string, email: string) {
  await rateLimit(`mfa-enroll:${userId}`, 10, 3600);
  const secret = generateSecret();
  await query('DELETE FROM mfa_methods WHERE user_id=$1 AND confirmed_at IS NULL', [userId]);
  await query('INSERT INTO mfa_methods(user_id, secret_enc) VALUES ($1,$2)', [userId, encrypt(secret)]);
  return { secret, otpauthUri: generateURI({ issuer: 'Plataforma', label: email, secret }) };
}

function checkTotp(secret: string, token: string, lastStep: number | null) {
  const r = verifySync({ secret, token, epochTolerance: 30 } as any);
  if (!r.valid) return null;
  const step = (r as any).timeStep as number;
  if (lastStep !== null && step <= Number(lastStep)) return null; // replay
  return step;
}

export async function mfaConfirmEnrollment(userId: string, sessionId: string, token: string) {
  await rateLimit(`mfa:${userId}`, 10, 900);
  const m = await one<any>('SELECT * FROM mfa_methods WHERE user_id=$1 AND confirmed_at IS NULL', [userId]);
  if (!m) throw badRequest('no_enrollment');
  const step = checkTotp(decrypt(m.secret_enc), token, null);
  if (step === null) throw badRequest('invalid_code', 'Código inválido');
  const codes = Array.from({ length: 8 }, () => randomToken(6));
  await withTx(async (tx) => {
    await tx.query('UPDATE mfa_methods SET confirmed_at=now(), last_used_step=$2 WHERE id=$1', [m.id, step]);
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
    for (const c of codes) await tx.query('INSERT INTO mfa_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [userId, sha256(c)]);
    await tx.query('UPDATE sessions SET mfa_verified_at=now() WHERE id=$1', [sessionId]);
    await audit({ actorUserId: userId, action: 'mfa.enrolled', objectType: 'user', objectId: userId }, tx);
  });
  return { recoveryCodes: codes };
}

export async function mfaVerify(userId: string, sessionId: string, input: { token?: string; recoveryCode?: string }) {
  await rateLimit(`mfa:${userId}`, 10, 900);
  if (input.recoveryCode) {
    const ok = await withTx(async (tx) => {
      const r = await tx.query(
        `UPDATE mfa_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id`,
        [userId, sha256(input.recoveryCode!)]);
      if (!r.rowCount) return false;
      await tx.query('UPDATE sessions SET mfa_verified_at=now() WHERE id=$1', [sessionId]);
      await audit({ actorUserId: userId, action: 'mfa.recovery_code_used', objectType: 'user', objectId: userId }, tx);
      return true;
    });
    if (!ok) throw badRequest('invalid_code', 'Código inválido');
    return { ok: true };
  }
  const m = await one<any>('SELECT * FROM mfa_methods WHERE user_id=$1 AND confirmed_at IS NOT NULL', [userId]);
  if (!m || !input.token) throw badRequest('invalid_code', 'Código inválido');
  const step = checkTotp(decrypt(m.secret_enc), input.token, m.last_used_step);
  if (step === null) throw badRequest('invalid_code', 'Código inválido');
  const upd = await query('UPDATE mfa_methods SET last_used_step=$2 WHERE id=$1 AND (last_used_step IS NULL OR last_used_step < $2) RETURNING id', [m.id, step]);
  if (!upd.length) throw badRequest('invalid_code', 'Código inválido');
  await query('UPDATE sessions SET mfa_verified_at=now() WHERE id=$1', [sessionId]);
  return { ok: true };
}

/** Reset administrativo de MFA (perda de dispositivo sem códigos): exige motivo e é auditado. */
export async function adminResetMfa(actorId: string, targetUserId: string, reason: string) {
  if (!reason || reason.length < 5) throw badRequest('reason_required');
  await withTx(async (tx) => {
    await tx.query('DELETE FROM mfa_methods WHERE user_id=$1', [targetUserId]);
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [targetUserId]);
    await revokeAllSessions(targetUserId, 'mfa_reset', tx);
    await audit({ actorUserId: actorId, action: 'mfa.admin_reset', objectType: 'user', objectId: targetUserId, reason }, tx);
  });
}

export function assertMfaSatisfied(s: SessionInfo) {
  if (s.mfaRequired && !s.mfaVerified) {
    throw new AppError(403, 'mfa_required', s.mfaEnrolled ? 'Confirme o segundo fator' : 'Cadastre o segundo fator de autenticação');
  }
}
export function assertEmailVerified(s: SessionInfo) {
  if (!s.user.email_verified_at) throw forbidden('email_not_verified', 'Confirme seu e-mail para continuar');
}
