import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { createIncident, incidentSchema, listIncidents } from '@/server/modules/incidents';

export const GET = handle(async (req) => listIncidents((await requireAuth(req)).userId));
export const POST = handle(async (req) => createIncident((await requireAuth(req)).userId, await body(req, incidentSchema)));
