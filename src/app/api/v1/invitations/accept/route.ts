import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { acceptInvitation } from '@/server/modules/orgs';

export const POST = handle(async (req) => {
  const s = await requireAuth(req, { allowMfaPending: true });
  const b = await body(req, z.object({ token: z.string().min(20) }));
  return acceptInvitation(s.userId, b.token);
});
