import { z } from 'zod';
import { handle, body, idem, json } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import * as B from '@/server/modules/booking';

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const s = await requireAuth(req);
  const b = await body(req, z.object({ startsAt: z.string().datetime(), offeringId: z.string().uuid().optional() })); const r = await B.rescheduleAppointment(s.userId, id, b, idem(req)); return json(r.body, { status: r.status });
});
