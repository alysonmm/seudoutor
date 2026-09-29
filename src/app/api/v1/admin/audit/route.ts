import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { listAudit } from '@/server/modules/incidents';

export const GET = handle(async (req) => {
  const q = new URL(req.url).searchParams;
  return listAudit((await requireAuth(req)).userId, { action: q.get('action') ?? undefined, organizationId: q.get('organizationId') ?? undefined });
});
