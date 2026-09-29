import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { advanceIncident } from '@/server/modules/incidents';

export const PATCH = handle<{ id: string }>(async (req, { id }) => {
  const b = await body(req, z.object({ status: z.enum(['identified', 'contained', 'assessing', 'communicated', 'closed']), note: z.string().max(300).optional() }));
  await advanceIncident((await requireAuth(req)).userId, id, b.status, b.note);
  return null;
});
