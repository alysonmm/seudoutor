import { handle, body, idem, json } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { bookAppointment, bookSchema } from '@/server/modules/booking';

export const POST = handle(async (req) => {
  const s = await requireAuth(req);
  const raw = await body(req, bookSchema);
  const r = await bookAppointment(s.userId, raw, idem(req));
  return json(r.body, { status: r.status });
});
