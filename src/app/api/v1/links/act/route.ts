import { z } from 'zod';
import { handle, body } from '@/server/http';
import { notFound } from '@/server/lib/errors';
import { verifyLink } from '@/server/lib/crypto';
import { rateLimit } from '@/server/lib/rate-limit';
import { cancelAppointment, confirmAttendance } from '@/server/modules/booking';

/** Somente POST executa a ação. */
export const POST = handle(async (req) => {
  const b = await body(req, z.object({ token: z.string().min(20).max(400), action: z.enum(['confirm', 'cancel']) }));
  await rateLimit('link-act:' + b.token.slice(0, 24), 10, 3600);
  const v = verifyLink(b.token, b.action === 'confirm' ? 'appt_confirm' : 'appt_cancel');
  if (!v) throw notFound('link_invalid', 'Link inválido ou expirado');
  return b.action === 'confirm' ? confirmAttendance(null, v.subjectId, true) : cancelAppointment(null, v.subjectId, 'Cancelado pelo paciente via link', true);
});
