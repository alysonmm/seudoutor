import { z } from 'zod';
import { handle } from '@/server/http';
import { notFound } from '@/server/lib/errors';
import { publicAvailability } from '@/server/modules/search';

export const GET = handle(async (req) => {
  const q = z.object({ offeringId: z.string().uuid(), from: z.string().date(), to: z.string().date() }).parse(Object.fromEntries(new URL(req.url).searchParams));
  return (await publicAvailability(q.offeringId, q.from, q.to)) ?? Promise.reject(notFound());
});
