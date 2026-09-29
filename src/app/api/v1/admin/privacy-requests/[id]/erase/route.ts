import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { executeErasure } from '@/server/modules/privacy';

export const POST = handle<{ id: string }>(async (req, { id }) => executeErasure((await requireAuth(req)).userId, id));
