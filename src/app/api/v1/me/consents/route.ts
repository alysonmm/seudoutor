import { z } from 'zod';
import { handle, body } from '@/server/http';
import { requireAuth } from '@/server/modules/authz';
import { currentConsents, setConsent, setNotificationPreference } from '@/server/modules/privacy';

export const GET = handle(async (req) => currentConsents((await requireAuth(req)).userId));
export const PUT = handle(async (req) => {
  const s = await requireAuth(req);
  const b = await body(req, z.object({
    consent: z.object({ purpose: z.enum(['marketing', 'geolocation', 'push', 'whatsapp']), granted: z.boolean() }).optional(),
    notification: z.object({ channel: z.enum(['email', 'whatsapp', 'push']), category: z.enum(['operational', 'marketing']), enabled: z.boolean() }).optional(),
  }));
  if (b.consent) await setConsent(s.userId, b.consent.purpose, b.consent.granted);
  if (b.notification) await setNotificationPreference(s.userId, b.notification.channel, b.notification.category, b.notification.enabled);
  return currentConsents(s.userId);
});
