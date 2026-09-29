import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { removeMember } from '@/server/modules/orgs';

export const DELETE = handle<{ orgId: string; membershipId: string }>(async (req, { orgId, membershipId }) => {
  await removeMember((await requireAuth(req)).userId, orgId, membershipId);
  return null;
});
