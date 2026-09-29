import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { exportMyData } from '@/server/modules/privacy';

export const GET = handle(async (req) => exportMyData((await requireAuth(req)).userId));
