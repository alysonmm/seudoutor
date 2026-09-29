import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { listMyOrganizations } from '@/server/modules/orgs';
import { query } from '@/server/db';

export const GET = handle(async (req) => {
  const s = await requireAuth(req, { allowMfaPending: true });
  const staff = await query('SELECT role_id FROM platform_staff WHERE user_id=$1 AND status=\'active\'', [s.userId]);
  return {
    user: s.user,
    mfa: { required: s.mfaRequired, enrolled: s.mfaEnrolled, verified: s.mfaVerified },
    organizations: s.mfaRequired && !s.mfaVerified ? [] : await listMyOrganizations(s.userId),
    platformRoles: s.mfaRequired && !s.mfaVerified ? [] : staff.map((r) => r.role_id),
  };
});
