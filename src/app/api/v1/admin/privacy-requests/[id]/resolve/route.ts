import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { resolvePrivacyRequest } from '@/server/modules/privacy';

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const b = await body(req, z.object({ status: z.enum(['fulfilled', 'partially_fulfilled', 'denied']), decision: z.string(), retainedCategories: z.array(z.string()).optional(), responsible: z.string().optional() }));
  await resolvePrivacyRequest((await requireAuth(req)).userId, id, b);
  return null;
});
