import { z } from 'zod';
import { handle, body, clientIp } from '@/server/http';
import { verifyEmail } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const b = await body(req, z.object({ email: z.string(), code: z.string().regex(/^\d{6}$/) }));
  return verifyEmail({ ...b, ip: clientIp(req) });
});
