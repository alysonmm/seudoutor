import { handle } from '@/server/http';
import { requireAuth, requirePlatform } from '@/server/modules/authz';
import { listFlags } from '@/server/modules/flags';

export const GET = handle(async (req) => { await requirePlatform((await requireAuth(req)).userId, 'feature.manage'); return listFlags(); });
