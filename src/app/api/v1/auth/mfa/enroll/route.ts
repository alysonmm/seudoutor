import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { mfaBeginEnrollment } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const s = await requireAuth(req, { allowMfaPending: true });
  if (s.mfaEnrolled && !s.mfaVerified) return Response.json({ error: { code: 'mfa_required' } }, { status: 403 });
  return mfaBeginEnrollment(s.userId, s.user.email);
});
