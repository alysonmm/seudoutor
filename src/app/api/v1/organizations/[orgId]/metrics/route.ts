import { z } from 'zod';
import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { orgMetrics } from '@/server/modules/reports';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => {
  const q = z.object({ from: z.string().date(), to: z.string().date() }).parse(Object.fromEntries(new URL(req.url).searchParams));
  return orgMetrics((await requireAuth(req)).userId, orgId, q.from, q.to);
});
