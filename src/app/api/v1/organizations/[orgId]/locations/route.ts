import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createLocation, listLocations, locationSchema } from '@/server/modules/catalog';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => listLocations((await requireAuth(req)).userId, orgId));
export const POST = handle<{ orgId: string }>(async (req, { orgId }) => createLocation((await requireAuth(req)).userId, orgId, await body(req, locationSchema)));
