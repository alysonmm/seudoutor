import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { submitForReview } from '@/server/modules/credentialing';

export const POST = handle<{ orgId: string; pid: string }>(async (req, { orgId, pid }) => submitForReview((await requireAuth(req)).userId, orgId, pid));
