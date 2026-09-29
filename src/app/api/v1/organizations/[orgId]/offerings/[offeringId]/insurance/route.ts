import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { setAcceptedInsurance } from '@/server/modules/catalog';

export const PUT = handle<{ orgId: string; offeringId: string }>(async (req, { orgId, offeringId }) => {
  const b = await body(req, z.object({ items: z.array(z.object({ insuranceProductId: z.string().uuid(), requiresAuthorization: z.boolean().optional() })) }));
  await setAcceptedInsurance((await requireAuth(req)).userId, orgId, offeringId, b.items);
  return null;
});
