import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createService } from '@/server/modules/catalog';

export const POST = handle<{ orgId: string }>(async (req, { orgId }) => {
  const b = await body(req, z.object({ name: z.string() }));
  return createService((await requireAuth(req)).userId, orgId, b.name);
});
