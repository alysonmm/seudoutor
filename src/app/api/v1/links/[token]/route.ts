import { handle } from '@/server/http';
import { notFound } from '@/server/lib/errors';
import { verifyLink } from '@/server/lib/crypto';
import { one } from '@/server/db';

/** GET nunca altera estado (scanners de e-mail): apenas informa o que a ação faria. */
export const GET = handle<{ token: string }>(async (_req, { token }) => {
  for (const purpose of ['appt_confirm', 'appt_cancel'] as const) {
    const v = verifyLink(token, purpose);
    if (!v) continue;
    const a = await one<any>('SELECT starts_at, timezone, status, attendance FROM appointments WHERE id=$1', [v.subjectId]);
    if (!a) throw notFound();
    return { action: purpose === 'appt_confirm' ? 'confirm' : 'cancel', startsAt: a.starts_at, timezone: a.timezone, status: a.status, attendance: a.attendance };
  }
  throw notFound('link_invalid', 'Link inválido ou expirado');
});
