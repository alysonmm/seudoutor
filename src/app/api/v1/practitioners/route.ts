import { handle } from '@/server/http';
import { searchPractitioners } from '@/server/modules/search';

export const GET = handle(async (req) => searchPractitioners(Object.fromEntries(new URL(req.url).searchParams)));
