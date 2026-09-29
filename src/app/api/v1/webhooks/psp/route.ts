import { errorResponse, json } from '@/server/http';
import { handlePspWebhook } from '@/server/modules/billing';

/** Webhook do PSP: corpo bruto + assinatura HMAC + timestamp; idempotente por id de evento. */
export async function POST(req: Request) {
  try {
    const raw = await req.text();
    if (raw.length > 200_000) return json({ error: { code: 'payload_too_large' } }, { status: 413 });
    const r = await handlePspWebhook(raw, req.headers.get('x-psp-signature'), req.headers.get('x-psp-timestamp'));
    return json(r);
  } catch (e) { return errorResponse(e); }
}
