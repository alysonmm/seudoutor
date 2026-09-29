import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { listOpenRequests } from '@/server/modules/privacy';

export const GET = handle(async (req) => listOpenRequests((await requireAuth(req)).userId));
