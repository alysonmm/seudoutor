import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { publicFieldsSchema, updatePublicFields } from '@/server/modules/credentialing';

export const PATCH = handle<{ orgId: string; pid: string }>(async (req, { orgId, pid }) => {
  await updatePublicFields((await requireAuth(req)).userId, orgId, pid, await body(req, publicFieldsSchema));
  return null;
});
