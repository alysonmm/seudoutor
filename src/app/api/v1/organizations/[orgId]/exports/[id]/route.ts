import { handle } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { downloadExport } from '@/server/modules/reports';

export const GET = handle<{ orgId: string; id: string }>(async (req, { orgId, id }) => {
  const csv = await downloadExport((await requireAuth(req)).userId, orgId, id);
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="export.csv"', 'cache-control': 'no-store' } });
});
