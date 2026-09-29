import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { mfaVerify } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const s = await requireAuth(req, { allowMfaPending: true });
  const b = await body(req, z.object({ token: z.string().optional(), recoveryCode: z.string().optional() }));
  return mfaVerify(s.userId, s.sessionId, b);
});
