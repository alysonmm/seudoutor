import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createException, exceptionSchema } from '@/server/modules/availability';

export const POST = handle<{ orgId: string }>(async (req, { orgId }) => createException((await requireAuth(req)).userId, orgId, await body(req, exceptionSchema)));
