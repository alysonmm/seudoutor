import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { getMyAppointment } from '@/server/modules/booking';

export const GET = handle<{ id: string }>(async (req, { id }) => getMyAppointment((await requireAuth(req)).userId, id));
