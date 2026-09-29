import { DateTime } from 'luxon';
import { one, query, withTx, type Db } from '../db';
import { config } from '../config';
import { sendEmail } from '../lib/email';
import { signLink } from '../lib/crypto';
import { setting } from '../lib/settings';
import { isEnabled } from './flags';

const MAX_ATTEMPTS = 5;

/** Usuário destinatário do paciente da consulta (conta verificada vinculada ou solicitante). */
async function recipientOf(db: Db, appt: any): Promise<string | null> {
  if (appt.requested_by_user_id) return appt.requested_by_user_id;
  const r = await one<{ user_id: string }>(
    `SELECT pa.user_id FROM patient_account_links l JOIN patient_accounts pa ON pa.id=l.patient_account_id WHERE l.organization_patient_id=$1`, [appt.organization_patient_id], db);
  return r?.user_id ?? null;
}

async function enqueue(db: Db, j: { userId: string; appointmentId: string | null; channel: 'email' | 'whatsapp'; template: string; sendAt: Date; dedupe: string }) {
  await db.query(
    `INSERT INTO notification_jobs(user_id, appointment_id, channel, template_key, send_at, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [j.userId, j.appointmentId, j.channel, j.template, j.sendAt, j.dedupe]);
}

/** Consumidor idempotente do outbox (ao menos uma vez; dedupe por chave). */
export async function processOutbox(limit = 50): Promise<number> {
  let done = 0;
  for (let i = 0; i < limit; i++) {
    const handled = await withTx(async (tx) => {
      const ev = await one<any>(
        `SELECT * FROM outbox_events WHERE processed_at IS NULL AND available_at <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [], tx);
      if (!ev) return false;
      try {
        await tx.query('SAVEPOINT h');
        await handleEvent(tx, ev);
        await tx.query('UPDATE outbox_events SET processed_at=now(), attempts=attempts+1 WHERE id=$1', [ev.id]);
      } catch (e: any) {
        await tx.query('ROLLBACK TO SAVEPOINT h');
        await tx.query(`UPDATE outbox_events SET attempts=attempts+1, last_error=$2, available_at=now() + (interval '1 minute' * power(2, LEAST(attempts,6))) WHERE id=$1`, [ev.id, String(e.message).slice(0, 300)]);
      }
      return true;
    });
    if (!handled) break;
    done++;
  }
  return done;
}

async function handleEvent(tx: Db, ev: any) {
  const p = ev.payload;
  if (ev.event_type === 'AppointmentScheduled' || ev.event_type === 'AppointmentRescheduled') {
    if (ev.event_type === 'AppointmentRescheduled') {
      await tx.query(`UPDATE notification_jobs SET status='skipped', skip_reason='appointment_rescheduled' WHERE appointment_id=$1 AND status='pending'`, [p.previousAppointmentId]);
    }
    const a = await one<any>('SELECT * FROM appointments WHERE id=$1', [p.appointmentId], tx);
    if (!a || a.status !== 'scheduled') return; // pendente de aprovação ou já cancelada: nada a anunciar
    const uid = await recipientOf(tx, a);
    if (!uid) return; // paciente local sem conta verificada: sem canal digital
    const v = a.version;
    await enqueue(tx, { userId: uid, appointmentId: a.id, channel: 'email', template: 'appointment_scheduled', sendAt: new Date(), dedupe: `appt:${a.id}:v${v}:confirm` });
    const offsets = await setting<number[]>('reminder_offsets_minutes', [1440, 180], tx);
    const now = Date.now();
    for (const off of offsets) {
      const at = new Date(new Date(a.starts_at).getTime() - off * 60_000);
      if (at.getTime() <= now + 60_000) continue; // consulta marcada em cima da hora: não cria lembrete vencido
      await enqueue(tx, { userId: uid, appointmentId: a.id, channel: 'email', template: 'appointment_reminder', sendAt: at, dedupe: `appt:${a.id}:rem${off}` });
      if (await isEnabled('whatsapp_messages', tx)) {
        await enqueue(tx, { userId: uid, appointmentId: a.id, channel: 'whatsapp', template: 'appointment_reminder', sendAt: at, dedupe: `appt:${a.id}:wa${off}` });
      }
    }
  } else if (ev.event_type === 'AppointmentCancelled') {
    await tx.query(`UPDATE notification_jobs SET status='skipped', skip_reason='appointment_cancelled' WHERE appointment_id=$1 AND status='pending'`, [p.appointmentId]);
    const a = await one<any>('SELECT * FROM appointments WHERE id=$1', [p.appointmentId], tx);
    const uid = a && (await recipientOf(tx, a));
    if (uid) await enqueue(tx, { userId: uid, appointmentId: a.id, channel: 'email', template: 'appointment_cancelled', sendAt: new Date(), dedupe: `appt:${a.id}:cancel` });
  } else if (ev.event_type === 'PractitionerSuspended') {
    for (const id of p.affectedAppointmentIds ?? []) {
      const a = await one<any>('SELECT * FROM appointments WHERE id=$1', [id], tx);
      const uid = a && (await recipientOf(tx, a));
      if (uid) await enqueue(tx, { userId: uid, appointmentId: id, channel: 'email', template: 'appointment_cancelled', sendAt: new Date(), dedupe: `appt:${id}:suspended` });
    }
  }
  // AttendanceConfirmed e demais eventos: sem consumidores no MVP.
}

/** Envia jobs vencidos. Revalida o estado da consulta IMEDIATAMENTE antes do envio (AC09). */
export async function processDueJobs(limit = 50, now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const r = await withTx(async (tx) => {
      const job = await one<any>(
        `SELECT * FROM notification_jobs WHERE status='pending' AND send_at <= $1 ORDER BY send_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [now], tx);
      if (!job) return null;
      const skip = async (reason: string) => {
        await tx.query(`UPDATE notification_jobs SET status='skipped', skip_reason=$2 WHERE id=$1`, [job.id, reason]);
        await tx.query(`INSERT INTO delivery_events(job_id, event, provider, detail) VALUES ($1,'skipped','n/a',$2)`, [job.id, reason]);
        return 'skipped' as const;
      };
      // 1) estado atual da consulta
      let appt: any = null;
      if (job.appointment_id) {
        appt = await one<any>('SELECT * FROM appointments WHERE id=$1 FOR SHARE', [job.appointment_id], tx);
        const isReminder = job.template_key === 'appointment_reminder';
        if (isReminder && (!appt || appt.status !== 'scheduled' || new Date(appt.starts_at) <= now || ['completed', 'no_show'].includes(appt.attendance))) return skip('appointment_not_active');
        if (job.template_key === 'appointment_scheduled' && (!appt || appt.status !== 'scheduled')) return skip('appointment_not_active');
      }
      // 2) preferências do usuário (canal operacional)
      const pref = await one<{ enabled: boolean }>(`SELECT enabled FROM notification_preferences WHERE user_id=$1 AND channel=$2 AND category='operational'`, [job.user_id, job.channel], tx);
      if (pref && !pref.enabled) return skip('user_preference');
      const user = await one<any>('SELECT email, email_verified_at, status FROM users WHERE id=$1', [job.user_id], tx);
      if (!user || user.status !== 'active') return skip('recipient_inactive');
      // 3) envio por adaptador; falha não é sucesso
      try {
        if (job.channel === 'whatsapp') {
          if (!(await isEnabled('whatsapp_messages', tx)) || config.whatsappMode === 'none') return skip('channel_unavailable');
          throw new Error('whatsapp_adapter_not_implemented');
        }
        if (!user.email_verified_at) return skip('contact_not_verified');
        const tpl = await one<any>(`SELECT subject, body FROM notification_templates WHERE key=$1 AND channel=$2 AND active ORDER BY version DESC LIMIT 1`, [job.template_key, job.channel], tx);
        if (!tpl) return skip('template_missing');
        let body: string = tpl.body.replaceAll('{{app_url}}', config.baseUrl);
        if (job.template_key === 'appointment_reminder' && appt) {
          // ações por link assinado: GET só exibe; a mudança de estado exige POST (AC16)
          const c = signLink('appt_confirm', appt.id, 48 * 3600), x = signLink('appt_cancel', appt.id, 48 * 3600);
          body += `\n\nConfirmar presença: ${config.baseUrl}/acoes/${c}\nCancelar: ${config.baseUrl}/acoes/${x}`;
        }
        await tx.query('SAVEPOINT s');
        const res = await sendEmail({ to: user.email, subject: tpl.subject, body }, tx);
        await tx.query(`UPDATE notification_jobs SET status='sent', sent_at=now(), attempts=attempts+1 WHERE id=$1`, [job.id]);
        await tx.query(`INSERT INTO delivery_events(job_id, event, provider) VALUES ($1,'sent',$2)`, [job.id, res.provider]);
        return 'sent' as const;
      } catch (e: any) {
        const attempts = job.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await tx.query(
          `UPDATE notification_jobs SET attempts=$2, last_error=$3, status=$4, send_at = now() + (interval '1 minute' * power(2, $2::int)) WHERE id=$1`,
          [job.id, attempts, String(e.code ?? e.message).slice(0, 200), dead ? 'dead' : 'pending']);
        await tx.query(`INSERT INTO delivery_events(job_id, event, provider, detail) VALUES ($1,'failed','n/a',$2)`, [job.id, String(e.code ?? e.message).slice(0, 200)]);
        return 'failed' as const;
      }
    });
    if (!r) break;
    out[r === 'sent' ? 'sent' : r === 'skipped' ? 'skipped' : 'failed']++;
  }
  return out;
}

export { DateTime, query };
