import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createPrivacyRequest, listMyPrivacyRequests, PRIVACY_KINDS } from '@/server/modules/privacy';

export const GET = handle(async (req) => listMyPrivacyRequests((await requireAuth(req)).userId));
export const POST = handle(async (req) => {
  const b = await body(req, z.object({ kind: z.enum(PRIVACY_KINDS), details: z.string().max(2000).optional() }));
  return createPrivacyRequest((await requireAuth(req)).userId, b.kind, b.details);
});
