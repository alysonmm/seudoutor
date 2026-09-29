import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createManualAppointment, listOrgAppointments, manualSchema } from '@/server/modules/booking';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => {
  const q = z.object({ from: z.string().datetime(), to: z.string().datetime(), practitionerId: z.string().uuid().optional() }).parse(Object.fromEntries(new URL(req.url).searchParams));
  return listOrgAppointments((await requireAuth(req)).userId, orgId, q.from, q.to, { practitionerId: q.practitionerId });
});
export const POST = handle<{ orgId: string }>(async (req, { orgId }) => createManualAppointment((await requireAuth(req)).userId, orgId, await body(req, manualSchema)));
