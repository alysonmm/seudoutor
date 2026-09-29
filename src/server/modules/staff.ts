import { requirePlatform } from './authz';
export async function authorizeStaff(userId: string, perm: string) {
  try { await requirePlatform(userId, perm); return true; } catch { return false; }
}
