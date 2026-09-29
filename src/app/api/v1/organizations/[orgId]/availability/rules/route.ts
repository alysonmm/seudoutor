import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createRule, listRules, ruleSchema } from '@/server/modules/availability';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => {
  const q = z.object({ practitionerId: z.string().uuid() }).parse(Object.fromEntries(new URL(req.url).searchParams));
  return listRules((await requireAuth(req)).userId, orgId, q.practitionerId);
});
export const POST = handle<{ orgId: string }>(async (req, { orgId }) => createRule((await requireAuth(req)).userId, orgId, await body(req, ruleSchema)));
