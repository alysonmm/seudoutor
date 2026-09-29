import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { listMembers } from '@/server/modules/orgs';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => listMembers((await requireAuth(req)).userId, orgId));
