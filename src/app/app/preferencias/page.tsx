import { requireUser } from '@/server/page-session';
import JsonForm from '@/components/JsonForm';
import { currentConsents } from '@/server/modules/privacy';

export const metadata = { title: 'Preferências' };

export default async function Preferencias() {
  const s = await requireUser('/app/preferencias');
  const c = await currentConsents(s.userId);
  const item = (purpose: string, label: string, help: string) => (
    <section className="card" key={purpose}><h2>{label}</h2><p className="small">{help}</p>
      <p>Situação: <strong>{c[purpose] ? 'ativado' : 'desativado'}</strong></p>
      <JsonForm action="/api/v1/me/consents" method="PUT" fixed={{ consent: { purpose, granted: !c[purpose] } }} fields={[]} submitLabel={c[purpose] ? 'Desativar' : 'Ativar'} secondary /></section>
  );
  return (
    <>
      <h1>Preferências</h1>
      <p>Tudo aqui é opcional e começa desativado. Recusar não impede buscar ou agendar.</p>
      {item('marketing', 'Comunicações de marketing', 'Ofertas e novidades. Nunca usamos sua especialidade ou frequência de consultas para isso.')}
      {item('geolocation', 'Localização', 'Usada apenas quando você toca em “usar minha localização” na busca.')}
      {item('push', 'Notificações no aparelho', 'Sem conteúdo sensível na tela bloqueada.')}
      <section className="card"><h2>Lembretes de agendamento por e-mail</h2>
        <p className="small">São mensagens operacionais e discretas. Você pode desligá-las, mas então não receberá avisos de cancelamento pelo canal.</p>
        <JsonForm action="/api/v1/me/consents" method="PUT" fixed={{ notification: { channel: 'email', category: 'operational', enabled: false } }} fields={[]} submitLabel="Desligar lembretes por e-mail" secondary />
        <JsonForm action="/api/v1/me/consents" method="PUT" fixed={{ notification: { channel: 'email', category: 'operational', enabled: true } }} fields={[]} submitLabel="Ligar lembretes por e-mail" secondary /></section>
    </>
  );
}
