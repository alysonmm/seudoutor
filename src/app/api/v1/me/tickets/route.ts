import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createTicket } from '@/server/modules/quality';

export const POST = handle(async (req) => {
  const b = await body(req, z.object({ subject: z.string().min(3), body: z.string().min(3), organizationId: z.string().uuid().optional() }));
  return createTicket((await requireAuth(req)).userId, b);
});
