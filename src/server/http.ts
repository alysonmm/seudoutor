import { ZodError, type ZodType } from 'zod';
import { AppError } from './lib/errors';
import { config } from './config';
import { SESSION_COOKIE } from './modules/authz';

type Ctx<P> = { params: Promise<P> };
type Handler<P> = (req: Request, params: P) => Promise<Response | object | null>;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Proteção CSRF por verificação de origem em requisições mutantes (além de SameSite=Lax). */
function assertSameOrigin(req: Request) {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  const u = new URL(req.url);
  if (origin) {
    let ok = false;
    try { const o = new URL(origin); ok = o.host === u.host || o.origin === new URL(config.baseUrl).origin; } catch { ok = false; }
    if (!ok) throw new AppError(403, 'csrf_origin', 'Origem não permitida');
  } else if (site === 'cross-site') {
    throw new AppError(403, 'csrf_origin', 'Origem não permitida');
  }
}

export function json(body: unknown, init: ResponseInit = {}) {
  const h = new Headers(init.headers);
  h.set('content-type', 'application/json; charset=utf-8');
  h.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

export function sessionCookie(token: string, expires: Date) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${config.isProd ? '; Secure' : ''}`;
}
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.isProd ? '; Secure' : ''}`;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status });
  if (e instanceof ZodError) {
    return json({ error: { code: 'validation_error', message: 'Dados inválidos', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } }, { status: 400 });
  }
  const pg = e as { code?: string; constraint?: string };
  if (pg?.code === '23P01') return json({ error: { code: 'slot_conflict', message: 'Horário indisponível' } }, { status: 409 });
  if (pg?.code === '23505') return json({ error: { code: 'duplicate', message: 'Registro já existe' } }, { status: 409 });
  const id = Math.random().toString(36).slice(2, 10);
  console.error(`[erro ${id}]`, (e as Error)?.message); // sem payloads/dados pessoais
  return json({ error: { code: 'internal_error', message: 'Erro interno', requestId: id } }, { status: 500 });
}

export function handle<P = Record<string, never>>(fn: Handler<P>) {
  return async (req: Request, ctx?: Ctx<P>): Promise<Response> => {
    try {
      assertSameOrigin(req);
      const params = ctx ? await ctx.params : ({} as P);
      const out = await fn(req, params);
      if (out instanceof Response) return out;
      if (out === null) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      return json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const text = await req.text();
  if (text.length > 100_000) throw new AppError(413, 'payload_too_large');
  let raw: unknown = {};
  if (text) { try { raw = JSON.parse(text); } catch { throw new AppError(400, 'invalid_json', 'JSON inválido'); } }
  return schema.parse(raw);
}

export function clientIp(req: Request) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'na';
}
export function idem(req: Request) {
  return req.headers.get('idempotency-key') ?? undefined;
}
