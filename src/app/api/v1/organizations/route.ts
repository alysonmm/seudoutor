import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createOrganization, createOrgSchema, listMyOrganizations } from '@/server/modules/orgs';

export const GET = handle(async (req) => listMyOrganizations((await requireAuth(req)).userId));
export const POST = handle(async (req) => {
  const s = await requireAuth(req);
  return createOrganization(s.userId, await body(req, createOrgSchema));
});
