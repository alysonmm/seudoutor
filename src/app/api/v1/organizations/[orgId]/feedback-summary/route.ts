import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { feedbackSummary } from '@/server/modules/quality';

export const GET = handle<{ orgId: string }>(async (req, { orgId }) => feedbackSummary((await requireAuth(req)).userId, orgId));
