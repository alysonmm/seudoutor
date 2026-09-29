import { z } from 'zod';
import { handle, body, clientIp, json, sessionCookie } from '@/server/http';
import { login } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const b = await body(req, z.object({ email: z.string(), password: z.string() }));
  const r = await login({ ...b, ip: clientIp(req), userAgent: req.headers.get('user-agent') ?? '' });
  const res = json({ mfaRequired: r.mfaRequired, mfaEnrolled: r.mfaEnrolled });
  res.headers.append('set-cookie', sessionCookie(r.token, r.expiresAt));
  return res;
});
