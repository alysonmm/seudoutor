import { z } from 'zod';
import { handle, body, clientIp } from '@/server/http';
import { requestPasswordReset } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const b = await body(req, z.object({ email: z.string() }));
  return requestPasswordReset(b.email, clientIp(req));
});
