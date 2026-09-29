import { handle } from '@/server/http';
import { requireFeature } from '@/server/modules/flags';

// Módulo BLOQUEADO: 403 enquanto a flag "clinic_payments" não tiver aprovação registrada; mesmo habilitada, 501 (sem implementação).
const blocked = handle(async () => requireFeature('clinic_payments'));
export const GET = blocked, POST = blocked, PUT = blocked, PATCH = blocked, DELETE = blocked;
