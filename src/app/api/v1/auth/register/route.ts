import { z } from 'zod';
import { handle, body, clientIp } from '@/server/http';
import { register } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const b = await body(req, z.object({ email: z.string(), password: z.string(), fullName: z.string(), phone: z.string().optional(), acceptTerms: z.boolean() }));
  return register({ ...b, ip: clientIp(req) });
});
