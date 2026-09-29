import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { reinstatePractitioner } from '@/server/modules/credentialing';

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const b = await body(req, z.object({ reason: z.string().min(5).max(500) }));
  await reinstatePractitioner((await requireAuth(req)).userId, id, b.reason);
  return null;
});
