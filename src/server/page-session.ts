import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveSession, type SessionInfo } from './modules/identity';
import { SESSION_COOKIE } from './modules/authz';
import { listMyOrganizations } from './modules/orgs';
import { query } from './db';

/** Sessão para Server Components. A autorização de dados continua nos módulos (servidor). */
export async function pageSession(): Promise<SessionInfo | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(next?: string): Promise<SessionInfo> {
  const s = await pageSession();
  if (!s) redirect('/entrar' + (next ? `?next=${encodeURIComponent(next)}` : ''));
  if (s.mfaRequired && !s.mfaVerified) redirect('/entrar?etapa=mfa' + (next ? `&next=${encodeURIComponent(next)}` : ''));
  return s;
}

export async function requireOrgContext(orgParam?: string, next = '/painel') {
  const s = await requireUser(next);
  const orgs = await listMyOrganizations(s.userId);
  if (!orgs.length) redirect('/painel/novo');
  const org = orgs.find((o: any) => o.id === orgParam) ?? orgs[0];
  return { session: s, orgs, org: org as { id: string; name: string; slug: string; kind: string; roles: string[] } };
}

export async function requireStaff(next = '/admin') {
  const s = await requireUser(next);
  const roles = (await query<{ role_id: string }>("SELECT role_id FROM platform_staff WHERE user_id=$1 AND status='active'", [s.userId])).map((r) => r.role_id);
  if (!roles.length) redirect('/');
  return { session: s, roles };
}
