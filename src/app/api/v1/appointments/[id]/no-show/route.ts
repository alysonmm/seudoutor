import { z } from 'zod';
import { handle, body, idem, json } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import * as B from '@/server/modules/booking';

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const s = await requireAuth(req);
  const b = await body(req, z.object({ reason: z.string().max(300).optional() })); return B.closeAppointment(s.userId, id, 'no_show', b.reason);
});
