import { verifyLink } from '@/server/lib/crypto';
import { one } from '@/server/db';
import LinkAction from '@/components/LinkAction';

export const metadata = { title: 'Ação no agendamento' };

export default async function Acao({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  for (const [purpose, action] of [['appt_confirm', 'confirm'], ['appt_cancel', 'cancel']] as const) {
    const v = verifyLink(token, purpose);
    if (!v) continue;
    const a = await one<any>('SELECT starts_at, timezone, status FROM appointments WHERE id=$1', [v.subjectId]);
    if (!a) break;
    const when = new Date(a.starts_at).toLocaleString('pt-BR', { timeZone: a.timezone, dateStyle: 'full', timeStyle: 'short' });
    return (<div style={{ maxWidth: 480 }}><h1>{action === 'confirm' ? 'Confirmar presença' : 'Cancelar agendamento'}</h1>
      {a.status !== 'scheduled' ? <p>Este agendamento não está ativo.</p> : <LinkAction token={token} action={action} when={when} />}</div>);
  }
  return <div><h1>Link inválido ou expirado</h1><p>Acesse o aplicativo para gerenciar seus agendamentos.</p></div>;
}
