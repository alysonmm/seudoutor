import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { blockSchema, createBlock } from '@/server/modules/availability';

export const POST = handle<{ orgId: string }>(async (req, { orgId }) => createBlock((await requireAuth(req)).userId, orgId, await body(req, blockSchema)));
