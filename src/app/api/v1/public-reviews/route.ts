import { handle } from '@/server/http';
import { requireFeature } from '@/server/modules/flags';

// Módulo BLOQUEADO: 403 enquanto a flag "public_reviews" não tiver aprovação registrada; mesmo habilitada, 501 (sem implementação).
const blocked = handle(async () => requireFeature('public_reviews'));
export const GET = blocked, POST = blocked, PUT = blocked, PATCH = blocked, DELETE = blocked;
