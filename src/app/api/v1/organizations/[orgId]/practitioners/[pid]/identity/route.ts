import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { identitySchema, saveIdentity } from '@/server/modules/credentialing';

export const PUT = handle<{ orgId: string; pid: string }>(async (req, { orgId, pid }) => {
  await saveIdentity((await requireAuth(req)).userId, orgId, pid, await body(req, identitySchema));
  return null;
});
