import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { cancelSubscription, checkoutSchema, getSubscription, startSubscription } from '@/server/modules/billing';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => getSubscription((await requireAuth(req)).userId, orgId));
export const POST = handle<{ orgId: string }>(async (req, { orgId }) => startSubscription((await requireAuth(req)).userId, orgId, await body(req, checkoutSchema)));
export const DELETE = handle<{ orgId: string }>(async (req, { orgId }) => cancelSubscription((await requireAuth(req)).userId, orgId));
