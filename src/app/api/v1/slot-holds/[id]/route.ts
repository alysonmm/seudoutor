import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { releaseHold } from '@/server/modules/booking';

export const DELETE = handle<{ id: string }>(async (req, { id }) => { await releaseHold((await requireAuth(req)).userId, id); return null; });
