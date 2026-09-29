import { query, one, pool, type Db } from '../db';
import { forbidden, notFound } from '../lib/errors';
import { resolveSession, assertMfaSatisfied, type SessionInfo } from './identity';

interface ScopeEntry { all: boolean; pids: Set<string>; lids: Set<string> }

/** Escopo efetivo de um usuário numa organização para uma permissão. Negar por padrão. */
export class Grant {
  constructor(public organizationId: string, public entries: ScopeEntry[]) {}
  get all() { return this.entries.some((e) => e.all); }
  /** Permite o par (médico, local)? Local opcional. */
  allows(practitionerId: string, locationId?: string | null) {
    return this.entries.some((e) => e.all ||
      (((e.pids.size === 0 && e.lids.size > 0) || e.pids.has(practitionerId)) &&
       (e.lids.size === 0 || !locationId || e.lids.has(locationId))));
  }
  allowsPractitioner(id: string) { return this.allows(id, null); }
  allowsLocation(id: string) { return this.entries.some((e) => e.all || e.lids.size === 0 || e.lids.has(id)); }
  /** Para filtrar listas: null = sem restrição de médico. */
  practitionerFilter(): string[] | null {
    if (this.all) return null;
    return [...new Set(this.entries.flatMap((e) => [...e.pids]))];
  }
  /** Fragmento SQL restringindo linhas com colunas practitioner_id/location_id; empurra parâmetros em `params`. */
  sql(alias: string, params: unknown[]): string {
    if (this.all) return 'true';
    const ors = this.entries.map((e) => {
      const parts: string[] = [];
      if (e.pids.size) { params.push([...e.pids]); parts.push(`${alias}.practitioner_id = ANY($${params.length}::uuid[])`); }
      if (e.lids.size) { params.push([...e.lids]); parts.push(`${alias}.location_id = ANY($${params.length}::uuid[])`); }
      return parts.length ? `(${parts.join(' AND ')})` : 'false';
    });
    return `(${ors.join(' OR ')})`;
  }
}

/**
 * Autoriza uma permissão dentro de uma organização, consultando o banco a cada chamada
 * (remoção de membro vale imediatamente; nada é confiado ao cliente).
 * - clinic_manager/finance: escopo total da organização
 * - practitioner: somente o próprio profissional
 * - secretary: somente os médicos/unidades atribuídos em member_scopes (sem atribuição = nada)
 */
export async function authorizeOrg(userId: string, organizationId: string, permission: string, db: Db = pool()): Promise<Grant> {
  const rows = await query<{ membership_id: string; role_id: string }>(
    `SELECT m.id AS membership_id, m.role_id
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
       JOIN role_permissions rp ON rp.role_id = m.role_id AND rp.permission = $3
      WHERE m.user_id=$1 AND m.organization_id=$2 AND m.status='active'`,
    [userId, organizationId, permission], db);
  if (!rows.length) throw forbidden();
  const entries: ScopeEntry[] = [];
  for (const r of rows) {
    if (r.role_id === 'clinic_manager' || r.role_id === 'finance') { entries.push({ all: true, pids: new Set(), lids: new Set() }); continue; }
    const pids = new Set<string>(), lids = new Set<string>();
    if (r.role_id === 'practitioner') {
      const p = await one<{ id: string }>(
        `SELECT p.id FROM practitioners p JOIN practitioner_memberships pm ON pm.practitioner_id = p.id AND pm.organization_id=$2 AND pm.status='active'
          WHERE p.user_id=$1`, [userId, organizationId], db);
      if (p) pids.add(p.id);
    } else {
      const scopes = await query<{ scope_type: string; scope_id: string }>(
        'SELECT scope_type, scope_id FROM member_scopes WHERE membership_id=$1', [r.membership_id], db);
      for (const s of scopes) (s.scope_type === 'practitioner' ? pids : lids).add(s.scope_id);
    }
    if (pids.size || lids.size) entries.push({ all: false, pids, lids });
  }
  if (!entries.length) throw forbidden(); // sem escopo atribuído = nada (negar por padrão)
  return new Grant(organizationId, entries);
}

/** Como authorizeOrg, mas devolve false em vez de lançar. */
export async function can(userId: string, organizationId: string, permission: string) {
  try { await authorizeOrg(userId, organizationId, permission); return true; } catch { return false; }
}

export async function requirePlatform(userId: string, permission: string, db: Db = pool()) {
  const r = await one(
    `SELECT 1 FROM platform_staff s JOIN role_permissions rp ON rp.role_id = s.role_id AND rp.permission=$2
      WHERE s.user_id=$1 AND s.status='active' LIMIT 1`, [userId, permission], db);
  if (!r) throw forbidden();
}

// ---------- Extração de sessão de Request ----------
export const SESSION_COOKIE = 'sid';

export function cookieFrom(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export async function sessionFromRequest(req: Request): Promise<SessionInfo | null> {
  return resolveSession(cookieFrom(req.headers.get('cookie'), SESSION_COOKIE));
}

/** Sessão válida + MFA satisfeito quando exigido. */
export async function requireAuth(req: Request, opts: { allowMfaPending?: boolean } = {}): Promise<SessionInfo> {
  const s = await sessionFromRequest(req);
  if (!s) throw new (await import('../lib/errors')).AppError(401, 'unauthenticated', 'Autenticação necessária');
  if (!opts.allowMfaPending) assertMfaSatisfied(s);
  return s;
}

export async function requirePatientAccount(userId: string, db: Db = pool()) {
  const p = await one<{ id: string }>('SELECT id FROM patient_accounts WHERE user_id=$1', [userId], db);
  if (!p) throw notFound('patient_account_missing');
  return p;
}
