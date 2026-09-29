import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { setSecretaryScopes } from '@/server/modules/orgs';

export const PUT = handle<{ orgId: string; membershipId: string }>(async (req, { orgId, membershipId }) => {
  const s = await requireAuth(req);
  const b = await body(req, z.object({ scopes: z.array(z.object({ type: z.enum(['practitioner', 'location']), id: z.string().uuid() })) }));
  await setSecretaryScopes(s.userId, orgId, membershipId, b.scopes);
  return null;
});
