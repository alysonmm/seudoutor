import { one, pool, type Db } from '../db';
import { config } from '../config';
import { AppError } from '../lib/errors';
import { sha256 } from '../lib/crypto';

export interface DocVersion { id: string; key: string; version: number; status: string; content_hash: string; body_md: string; title: string }

/**
 * Versão vigente de um documento. Produção: SOMENTE publicada (aprovada por humano).
 * Fora de produção: aceita a minuta mais recente para permitir desenvolvimento/teste com dados sintéticos.
 */
export async function currentVersion(key: string, db: Db = pool()): Promise<DocVersion> {
  const published = await one<DocVersion>(
    `SELECT v.id, d.key, d.title, v.version, v.status, v.content_hash, v.body_md
       FROM document_versions v JOIN legal_documents d ON d.id = v.document_id
      WHERE d.key = $1 AND v.status = 'published' ORDER BY v.version DESC LIMIT 1`, [key], db);
  if (published) return published;
  if (config.isProd) throw new AppError(503, 'document_not_published', `Documento "${key}" sem versão publicada e aprovada`);
  const draft = await one<DocVersion>(
    `SELECT v.id, d.key, d.title, v.version, v.status, v.content_hash, v.body_md
       FROM document_versions v JOIN legal_documents d ON d.id = v.document_id
      WHERE d.key = $1 ORDER BY v.version DESC LIMIT 1`, [key], db);
  if (!draft) throw new AppError(503, 'document_missing', `Documento "${key}" não cadastrado`);
  return draft;
}

export async function recordAcceptance(db: Db, userId: string, key: string, organizationId: string | null, context: Record<string, unknown> = {}) {
  const v = await currentVersion(key, db);
  const row = await one<{ id: string }>(
    `INSERT INTO terms_acceptances(user_id, organization_id, document_version_id, content_hash, context)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, organizationId, v.id, v.content_hash, JSON.stringify({ ...context, status_da_versao: v.status })], db);
  return { id: row!.id, version: v };
}

export async function upsertDocumentDraft(key: string, title: string, audience: string, body: string) {
  const hash = sha256(body);
  const doc = await one<{ id: string }>(
    `INSERT INTO legal_documents(key, title, audience) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET title = EXCLUDED.title RETURNING id`, [key, title, audience]);
  const last = await one<{ version: number; content_hash: string }>(
    'SELECT version, content_hash FROM document_versions WHERE document_id=$1 ORDER BY version DESC LIMIT 1', [doc!.id]);
  if (last?.content_hash === hash) return;
  await pool().query(
    `INSERT INTO document_versions(document_id, version, body_md, content_hash, status) VALUES ($1,$2,$3,$4,'draft_minuta')`,
    [doc!.id, (last?.version ?? 0) + 1, body, hash]);
}
