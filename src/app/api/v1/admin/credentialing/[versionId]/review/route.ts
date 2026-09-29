import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { reviewSchema, reviewVersion } from '@/server/modules/credentialing';

export const POST = handle<{ versionId: string }>(async (req, { versionId }) => reviewVersion((await requireAuth(req)).userId, versionId, await body(req, reviewSchema)));
