import crypto from 'node:crypto';
// Configuração e segredos. Em produção, ausência de segredo é erro fatal (falha fechada).
// Fora de produção há valores de DESENVOLVIMENTO, óbvios e inseguros de propósito.
function isProd() { return process.env.NODE_ENV === 'production'; }

function required(name: string, devFallback?: string): string {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (!isProd() && devFallback !== undefined) return devFallback;
  throw new Error(`Configuração ausente: ${name}`);
}

export const config = {
  get isProd() { return isProd(); },
  get databaseUrl() { return required('DATABASE_URL', 'postgres://seudoutor:seudoutor@localhost:5432/seudoutor_dev'); },
  get encryptionKey(): Buffer {
    const raw = required('APP_ENCRYPTION_KEY', 'dev-only-encryption-key-do-not-use-in-prod');
    // deriva 32 bytes estáveis a partir do segredo configurado
    return crypto.createHash('sha256').update(raw).digest();
  },
  get linkSecret() { return required('APP_LINK_SECRET', 'dev-only-link-secret-do-not-use-in-prod'); },
  get baseUrl() { return process.env.APP_BASE_URL ?? 'http://localhost:3000'; },
  get defaultTimezone() { return process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo'; },
  get emailMode() { return process.env.EMAIL_MODE ?? (isProd() ? 'none' : 'dev'); },
  get pspMode() { return process.env.PSP_MODE ?? (isProd() ? 'none' : 'sandbox'); },
  get pspWebhookSecret() { return required('PSP_WEBHOOK_SECRET', 'dev-only-psp-webhook-secret'); },
  get whatsappMode() { return process.env.WHATSAPP_MODE ?? 'none'; },
};
