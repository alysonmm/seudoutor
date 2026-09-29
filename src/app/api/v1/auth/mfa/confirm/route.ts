import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { mfaConfirmEnrollment } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const s = await requireAuth(req, { allowMfaPending: true });
  const b = await body(req, z.object({ token: z.string().regex(/^\d{6}$/) }));
  return mfaConfirmEnrollment(s.userId, s.sessionId, b.token);
});
