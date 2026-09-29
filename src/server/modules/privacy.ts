import { z } from 'zod';
import { one, query, withTx } from '../db';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { randomToken } from '../lib/crypto';
import { setting } from '../lib/settings';
import { requirePlatform } from './authz';
import { revokeAllSessions } from './identity';

export const PRIVACY_KINDS = ['access', 'correction', 'portability', 'erasure', 'revocation', 'other'] as const;

/** Prazo por tipo de direito vem de configuração (placeholder até o encarregado definir) — nunca um prazo único genérico. */
export async function createPrivacyRequest(userId: string, kind: (typeof PRIVACY_KINDS)[number], details?: string) {
  z.enum(PRIVACY_KINDS).parse(kind);
  const sla = await setting<Record<string, number>>('privacy_request_sla_days', {});
  const days = sla[kind] ?? sla.other ?? 15;
  const protocol = 'PV-' + Date.now().toString(36).toUpperCase() + randomToken(2).replace(/[^A-Za-z0-9]/g, 'x').toUpperCase();
  const r = await one<{ id: string; due_at: string }>(
    `INSERT INTO privacy_requests(protocol, user_id, kind, details, due_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5::int)) RETURNING id, due_at`,
    [protocol, userId, kind, details?.slice(0, 2000) ?? null, days]);
  await query(`INSERT INTO outbox_events(event_type, payload, dedupe_key) VALUES ('PrivacyRequestCreated', $1, $2) ON CONFLICT (dedupe_key) DO NOTHING`, [JSON.stringify({ privacyRequestId: r!.id, kind }), `privreq:${r!.id}`]);
  await audit({ actorUserId: userId, action: 'privacy.request_created', objectType: 'privacy_request', objectId: r!.id, metadata: { kind } });
  return { id: r!.id, protocol, dueAt: r!.due_at };
}
export async function listMyPrivacyRequests(userId: string) {
  return query('SELECT id, protocol, kind, status, due_at, decision, retained_categories, created_at, decided_at FROM privacy_requests WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
}

/** Acesso/portabilidade: somente dados do próprio titular. */
export async function exportMyData(userId: string) {
  const user = await one('SELECT id, email, email_verified_at, phone, full_name, created_at FROM users WHERE id=$1', [userId]);
  const appts = await query(
    `SELECT a.id, a.starts_at, a.ends_at, a.status, a.attendance, a.snapshot, a.created_at FROM appointments a
      WHERE a.requested_by_user_id=$1 OR a.organization_patient_id IN (SELECT l.organization_patient_id FROM patient_account_links l JOIN patient_accounts pa ON pa.id=l.patient_account_id WHERE pa.user_id=$1)
      ORDER BY a.starts_at`, [userId]);
  const [acceptances, consents, prefs, feedback, requests] = await Promise.all([
    query('SELECT ta.accepted_at, d.key, v.version, ta.content_hash FROM terms_acceptances ta JOIN document_versions v ON v.id=ta.document_version_id JOIN legal_documents d ON d.id=v.document_id WHERE ta.user_id=$1', [userId]),
    query('SELECT purpose, granted, at FROM consent_events WHERE user_id=$1 ORDER BY id', [userId]),
    query('SELECT channel, category, enabled FROM notification_preferences WHERE user_id=$1', [userId]),
    query('SELECT appointment_id, punctuality, communication, structure, comment, created_at FROM feedback WHERE user_id=$1', [userId]),
    query('SELECT protocol, kind, status, created_at FROM privacy_requests WHERE user_id=$1', [userId]),
  ]);
  await audit({ actorUserId: userId, action: 'privacy.data_exported', objectType: 'user', objectId: userId });
  return { generatedAt: new Date().toISOString(), user, appointments: appts, termsAcceptances: acceptances, consents, notificationPreferences: prefs, feedback, privacyRequests: requests };
}

export async function setConsent(userId: string, purpose: 'marketing' | 'geolocation' | 'push' | 'whatsapp', granted: boolean, context: Record<string, unknown> = {}) {
  await query('INSERT INTO consent_events(user_id, purpose, granted, context) VALUES ($1,$2,$3,$4)', [userId, purpose, granted, JSON.stringify(context)]);
  await audit({ actorUserId: userId, action: 'consent.changed', objectType: 'user', objectId: userId, metadata: { purpose, granted } });
}
export async function currentConsents(userId: string) {
  const rows = await query<{ purpose: string; granted: boolean }>(`SELECT DISTINCT ON (purpose) purpose, granted FROM consent_events WHERE user_id=$1 ORDER BY purpose, id DESC`, [userId]);
  const out: Record<string, boolean> = { marketing: false, geolocation: false, push: false, whatsapp: false }; // nunca pré-marcado
  for (const r of rows) out[r.purpose] = r.granted;
  return out;
}
export async function setNotificationPreference(userId: string, channel: 'email' | 'whatsapp' | 'push', category: 'operational' | 'marketing', enabled: boolean) {
  await query(`INSERT INTO notification_preferences(user_id, channel, category, enabled) VALUES ($1,$2,$3,$4)
               ON CONFLICT (user_id, channel, category) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`, [userId, channel, category, enabled]);
}

export async function listOpenRequests(actor: string) {
  await requirePlatform(actor, 'privacy.manage');
  return query(`SELECT r.id, r.protocol, r.kind, r.status, r.due_at, r.created_at, r.responsible FROM privacy_requests r WHERE r.status IN ('open','in_review') ORDER BY r.due_at`);
}

/** Decisão fundamentada obrigatória. Registra o que foi retido e por quê. */
export async function resolvePrivacyRequest(actor: string, id: string, input: { status: 'fulfilled' | 'partially_fulfilled' | 'denied'; decision: string; retainedCategories?: string[]; responsible?: string }) {
  await requirePlatform(actor, 'privacy.manage');
  if (!input.decision || input.decision.trim().length < 10) throw badRequest('decision_required', 'Informe a decisão fundamentada');
  if (input.status === 'partially_fulfilled' && !input.retainedCategories?.length) throw badRequest('retained_required', 'Indique as categorias retidas e o fundamento');
  const r = await one<any>('SELECT * FROM privacy_requests WHERE id=$1', [id]);
  if (!r) throw notFound();
  await query(`UPDATE privacy_requests SET status=$2, decision=$3, retained_categories=$4, decided_by=$5, decided_at=now(), responsible=COALESCE($6,responsible) WHERE id=$1`,
    [id, input.status, input.decision, input.retainedCategories ?? [], actor, input.responsible ?? null]);
  await audit({ actorUserId: actor, action: 'privacy.request_resolved', objectType: 'privacy_request', objectId: id, reason: input.decision.slice(0, 300), metadata: { status: input.status } });
}

/**
 * Executa a eliminação com MINIMIZAÇÃO: remove identificação e conteúdo livre; mantém somente registros
 * administrativos de agenda sem identificação direta (categoria retida a ser fundamentada pelo jurídico).
 * Sessões, MFA e verificações são removidos. Backups seguem a política de retenção (restauração deve reaplicar exclusões).
 */
export async function executeErasure(actor: string, requestId: string) {
  await requirePlatform(actor, 'privacy.manage');
  return withTx(async (tx) => {
    const r = await one<any>('SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE', [requestId], tx);
    if (!r || r.kind !== 'erasure') throw notFound('erasure_request_not_found');
    if (!r.decision) throw conflict('decision_required', 'Registre a decisão fundamentada antes de executar');
    const uid = r.user_id;
    const active = await one<{ n: string }>(
      `SELECT count(*) n FROM appointments a WHERE a.status IN ('scheduled','pending_approval') AND a.starts_at > now()
         AND (a.requested_by_user_id=$1 OR a.organization_patient_id IN (SELECT l.organization_patient_id FROM patient_account_links l JOIN patient_accounts pa ON pa.id=l.patient_account_id WHERE pa.user_id=$1))`, [uid], tx);
    if (Number(active!.n) > 0) throw conflict('active_appointments', 'Há consultas futuras ativas: cancele-as ou reagende o pedido');
    await tx.query(`UPDATE organization_patients SET full_name='Titular removido', phone=NULL, email=NULL, anonymized_at=now()
                     WHERE id IN (SELECT l.organization_patient_id FROM patient_account_links l JOIN patient_accounts pa ON pa.id=l.patient_account_id WHERE pa.user_id=$1)`, [uid]);
    await tx.query(`UPDATE appointments SET snapshot = snapshot - 'insurance' WHERE requested_by_user_id=$1`, [uid]);
    await tx.query('UPDATE feedback SET comment=NULL WHERE user_id=$1', [uid]);
    await tx.query('DELETE FROM notification_jobs WHERE user_id=$1 AND status <> \'sent\'', [uid]);
    await tx.query('DELETE FROM notification_preferences WHERE user_id=$1', [uid]);
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [uid]);
    await tx.query('DELETE FROM mfa_methods WHERE user_id=$1', [uid]);
    await tx.query('DELETE FROM contact_verifications WHERE user_id=$1', [uid]);
    await revokeAllSessions(uid, 'erasure', tx);
    await tx.query(`UPDATE users SET email=('removido+' || id || '@invalid.local'), phone=NULL, full_name='Titular removido', password_hash='!', status='deleted', email_verified_at=NULL, updated_at=now() WHERE id=$1`, [uid]);
    await audit({ actorUserId: actor, action: 'privacy.erasure_executed', objectType: 'user', objectId: uid, reason: r.decision.slice(0, 300), metadata: { retained: r.retained_categories } }, tx);
    return { userId: uid, retainedCategories: r.retained_categories };
  });
}
export { AppError };
