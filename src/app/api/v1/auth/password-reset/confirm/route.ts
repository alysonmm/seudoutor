import { z } from 'zod';
import { handle, body } from '@/server/http';
import { resetPassword } from '@/server/modules/identity';

export const POST = handle(async (req) => {
  const b = await body(req, z.object({ email: z.string(), code: z.string(), newPassword: z.string() }));
  return resetPassword(b);
});
