import { z } from 'zod';
import { one, query } from '../db';
import { audit } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { setting } from '../lib/settings';
import { authorizeOrg } from './authz';

/** Triagem de conteúdo sensível: diagnóstico, prescrição, documento pessoal, telefone. Só sinaliza — nunca publica. */
export function screenComment(text: string): string[] {
  const flags: string[] = [];
  if (/\b(diagn[oó]stic|cid[- ]?10|c[aâ]ncer|hiv|tumor|receita|prescri|medicament|exame de|laudo|tratamento de)\w*/i.test(text)) flags.push('clinical_content');
  if (/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(text)) flags.push('personal_document');
  if (/\(?\b\d{2}\)?\s?9?\d{4}-?\d{4}\b/.test(text)) flags.push('phone_number');
  if (/\b(meu|minha)\s+(filh[oa]|espos[oa]|marido|mulher|m[aã]e|pai)\b/i.test(text)) flags.push('third_party');
  return flags;
}

export const feedbackSchema = z.object({
  punctuality: z.number().int().min(1).max(5), communication: z.number().int().min(1).max(5), structure: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

/** Uma por consulta concluída; correção com histórico (revision). Permanece PRIVADO (public_reviews_enabled=false). */
export async function submitFeedback(userId: string, appointmentId: string, raw: z.input<typeof feedbackSchema>) {
  const f = feedbackSchema.parse(raw);
  const a = await one<any>(
    `SELECT a.* FROM appointments a WHERE a.id=$1 AND (a.requested_by_user_id=$2 OR a.organization_patient_id IN
       (SELECT l.organization_patient_id FROM patient_account_links l JOIN patient_accounts pa ON pa.id=l.patient_account_id WHERE pa.user_id=$2))`, [appointmentId, userId]);
  if (!a) throw notFound('appointment_not_found');
  if (a.attendance !== 'completed') throw conflict('not_completed', 'Só é possível avaliar consultas concluídas');
  const flags = f.comment ? screenComment(f.comment) : [];
  const status = flags.length ? 'flagged' : 'clean';
  const row = await one<{ id: string; revision: number }>(
    `INSERT INTO feedback(appointment_id, organization_id, practitioner_id, user_id, punctuality, communication, structure, comment, moderation_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (appointment_id) DO UPDATE SET punctuality=EXCLUDED.punctuality, communication=EXCLUDED.communication, structure=EXCLUDED.structure,
        comment=EXCLUDED.comment, moderation_status=EXCLUDED.moderation_status, revision=feedback.revision+1, updated_at=now()
     RETURNING id, revision`,
    [appointmentId, a.organization_id, a.practitioner_id, userId, f.punctuality, f.communication, f.structure, f.comment ?? null, status]);
  if (flags.length) {
    await query(`INSERT INTO moderation_cases(subject_type, subject_id, reason, due_at) VALUES ('feedback',$1,$2, now() + interval '5 days')`, [row!.id, 'Sinais automáticos: ' + flags.join(', ')]);
  }
  await audit({ actorUserId: userId, organizationId: a.organization_id, action: 'feedback.submitted', objectType: 'feedback', objectId: row!.id, metadata: { revision: row!.revision, flagged: flags } });
  return { id: row!.id, revision: row!.revision, visibility: 'private', flagged: flags.length > 0 };
}

/** Resumo agregado para o painel: só médias, com supressão de grupos pequenos; nunca comentários. */
export async function feedbackSummary(actor: string, org: string) {
  const g = await authorizeOrg(actor, org, 'reports.read');
  const min = await setting<number>('small_group_suppression_min', 5);
  const params: unknown[] = [org];
  const scope = g.sql('f', params);
  const r = await one<any>(`SELECT count(*)::int n, avg(punctuality)::float p, avg(communication)::float c, avg(structure)::float s FROM feedback f WHERE f.organization_id=$1 AND ${scope}`, params);
  if (!r || r.n < min) return { count: r?.n ?? 0, suppressed: true, note: `Poucos registros (mínimo ${min}) para exibir médias.` };
  return { count: r.n, suppressed: false, punctuality: +r.p.toFixed(2), communication: +r.c.toFixed(2), structure: +r.s.toFixed(2) };
}

export async function createTicket(userId: string, input: { organizationId?: string; subject: string; body: string }) {
  const protocol = 'ST-' + Date.now().toString(36).toUpperCase();
  await query('INSERT INTO support_tickets(protocol, user_id, organization_id, subject, body) VALUES ($1,$2,$3,$4,$5)', [protocol, userId, input.organizationId ?? null, input.subject.slice(0, 150), input.body.slice(0, 2000)]);
  return { protocol };
}
