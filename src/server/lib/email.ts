import { pool, type Db } from '../db';
import { config } from '../config';
import { unavailable } from './errors';

export interface OutgoingEmail { to: string; subject: string; body: string }

/**
 * Adaptador de e-mail.
 *  - dev: grava em `dev_mailbox` (SOMENTE fora de produção; identificado no nome da tabela).
 *  - qualquer outro modo (inclusive 'smtp', ainda não implementado): FALHA. Nunca simula sucesso.
 */
export async function sendEmail(mail: OutgoingEmail, db: Db = pool()): Promise<{ provider: string }> {
  if (config.emailMode === 'dev' && !config.isProd) {
    await db.query('INSERT INTO dev_mailbox(to_email, subject, body) VALUES ($1,$2,$3)', [mail.to, mail.subject, mail.body]);
    return { provider: 'dev_mailbox' };
  }
  throw unavailable('email_provider_not_configured', 'Provedor de e-mail não configurado para este ambiente');
}
