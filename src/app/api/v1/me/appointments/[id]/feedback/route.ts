import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { feedbackSchema, submitFeedback } from '@/server/modules/quality';

export const POST = handle<{ id: string }>(async (req, { id }) => submitFeedback((await requireAuth(req)).userId, id, await body(req, feedbackSchema)));
