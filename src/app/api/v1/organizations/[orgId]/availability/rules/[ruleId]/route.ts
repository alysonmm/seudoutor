import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { deactivateRule } from '@/server/modules/availability';

export const DELETE = handle<{ orgId: string; ruleId: string }>(async (req, { orgId, ruleId }) => {
  const b = await body(req, z.object({ acknowledgeImpactIds: z.array(z.string().uuid()).default([]) }));
  return deactivateRule((await requireAuth(req)).userId, orgId, ruleId, b.acknowledgeImpactIds);
});
