import { handle } from '@/server/http';
import { listInsurers, listSpecialties } from '@/server/modules/catalog';

export const GET = handle(async () => ({ specialties: await listSpecialties(), insurers: await listInsurers() }));
