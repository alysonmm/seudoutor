import { pool, type Db } from '../db';

export interface AuditInput {
  actorUserId?: string | null;
  actorKind?: 'user' | 'system' | 'webhook';
  organizationId?: string | null;
  action: string;
  objectType?: string;
  objectId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}
/** Metadados mínimos: nunca senha, token, texto clínico. Quem chama é responsável por não incluí-los. */
export async function audit(input: AuditInput, db: Db = pool()) {
  await db.query(
    `INSERT INTO audit_events(actor_user_id, actor_kind, organization_id, action, object_type, object_id, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.actorUserId ?? null, input.actorKind ?? 'user', input.organizationId ?? null, input.action,
     input.objectType ?? null, input.objectId ?? null, input.reason ?? null, JSON.stringify(input.metadata ?? {})],
  );
}
