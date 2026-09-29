import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import * as B from '@/server/modules/booking';

export const POST = handle<{ id: string }>(async (req, { id }) => {
  const s = await requireAuth(req);
  return B.confirmAttendance(s.userId, id);
});
