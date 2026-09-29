import crypto from 'node:crypto';
import { config } from '../config';

// Somente primitivas padrão do Node (scrypt, AES-256-GCM, HMAC-SHA256). Nada de criptografia própria.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const key = await new Promise<Buffer>((res, rej) =>
    crypto.scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem }, (e, k) => (e ? rej(e) : res(k))));
  return crypto.timingSafeEqual(key, expected);
}
function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => crypto.scrypt(password, salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
}
/** Hash dummy para igualar tempo de resposta quando o usuário não existe (evita enumeração por tempo). */
export const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret: string, data: string) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export function safeEqualHex(a: string, b: string) {
  const ba = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
export const randomDigits = (n = 6) => Array.from(crypto.randomBytes(n), (b) => b % 10).join('');
export const uuid = () => crypto.randomUUID();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/** Links assinados: finalidade única, curta duração, sem PII na URL. */
export function signLink(purpose: string, subjectId: string, ttlSeconds: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = `${purpose}.${subjectId}.${exp}`;
  return `${Buffer.from(body).toString('base64url')}.${hmacHex(config.linkSecret, body)}`;
}
export function verifyLink(token: string, purpose: string, now = Date.now()): { subjectId: string } | null {
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  let body: string;
  try { body = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  if (!safeEqualHex(hmacHex(config.linkSecret, body), sig)) return null;
  const [p, subjectId, exp] = body.split('.');
  if (p !== purpose || Number(exp) < Math.floor(now / 1000)) return null;
  return { subjectId };
}
