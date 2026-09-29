import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { listOfferings, offeringSchema, upsertOffering } from '@/server/modules/catalog';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => listOfferings((await requireAuth(req)).userId, orgId));
export const POST = handle<{ orgId: string }>(async (req, { orgId }) => upsertOffering((await requireAuth(req)).userId, orgId, await body(req, offeringSchema)));
