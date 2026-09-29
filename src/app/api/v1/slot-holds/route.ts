import { handle, body, idem, json } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createHold, holdSchema } from '@/server/modules/booking';

export const POST = handle(async (req) => {
  const s = await requireAuth(req);
  const r = await createHold(s.userId, await body(req, holdSchema), idem(req));
  return json(r.body, { status: r.status });
});
