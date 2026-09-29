import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { requestRefund } from '@/server/modules/billing';

export const POST = handle<{ orgId: string }>(async (req, { orgId }) => {
  const b = await body(req, z.object({ kind: z.enum(['withdrawal', 'refund', 'other']), reason: z.string().max(1000).optional() }));
  return requestRefund((await requireAuth(req)).userId, orgId, b);
});
