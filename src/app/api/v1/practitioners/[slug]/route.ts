import { handle } from '@/server/http';
import { notFound } from '@/server/lib/errors';
import { publicProfile } from '@/server/modules/search';

export const GET = handle<{ slug: string }>(async (_req, { slug }) => (await publicProfile(slug)) ?? Promise.reject(notFound()));
