import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { query } from '@/server/db';

export const PATCH = handle(async (req) => {
  const s = await requireAuth(req);
  const b = await body(req, z.object({ fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().max(30).optional() }));
  await query('UPDATE users SET full_name=COALESCE($2,full_name), phone=COALESCE($3,phone), updated_at=now() WHERE id=$1', [s.userId, b.fullName ?? null, b.phone ?? null]);
  return null;
});
