import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { adminMetrics, adminSpecialtyDistribution } from '@/server/modules/reports';

export const GET = handle(async (req) => {
  const s = await requireAuth(req);
  return { ...(await adminMetrics(s.userId)), specialties: await adminSpecialtyDistribution(s.userId) };
});
