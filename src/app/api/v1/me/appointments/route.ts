import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { listMyAppointments } from '@/server/modules/booking';

export const GET = handle(async (req) => listMyAppointments((await requireAuth(req)).userId));
