import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { requestExport } from '@/server/modules/reports';

export const POST = handle<{ orgId: string }>(async (req, { orgId }) => {
  const b = await body(req, z.object({ from: z.string().datetime(), to: z.string().datetime() }));
  return requestExport((await requireAuth(req)).userId, orgId, b.from, b.to);
});
