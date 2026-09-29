import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { listReviewQueue } from '@/server/modules/credentialing';

export const GET = handle(async (req) => listReviewQueue((await requireAuth(req)).userId));
