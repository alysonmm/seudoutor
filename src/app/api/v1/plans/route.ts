import { handle } from '@/server/http';
import { listPlans } from '@/server/modules/billing';

export const GET = handle(async () => listPlans());
