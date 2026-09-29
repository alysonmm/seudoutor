import { handle, json, clearSessionCookie } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { logout } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const s = await requireAuth(req, { allowMfaPending: true });
  await logout(s.sessionId);
  const res = json({ ok: true });
  res.headers.append('set-cookie', clearSessionCookie());
  res.headers.set('clear-site-data', '"cache", "storage"'); // aparelho compartilhado: limpa caches locais
  return res;
});
