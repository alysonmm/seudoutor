import Link from 'next/link';
import { listPlans } from '@/server/modules/billing';

export const metadata = { title: 'Planos para profissionais' };
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default async function Planos() {
  const plans = await listPlans();
  return (<><h1>Planos para médicos e clínicas</h1>
    <p>Ferramenta de agenda e divulgação de perfil por <strong>assinatura fixa</strong>. Sem comissão por paciente, encaminhamento, prescrição, consulta ou exame. Pacientes usam gratuitamente.</p>
    <p className="banner">Valores e limites abaixo são <strong>hipóteses comerciais em teste</strong>, sujeitas a validação. Teste gratuito sem cartão; a continuidade exige contratação expressa. Não há cobrança automática de excedente de mensagens.</p>
    <div className="grid cols-3">{plans.map((p: any) => (
      <article className="card" key={p.plan_id}><h2>{p.name}</h2>
        <p><strong>{brl(p.price_monthly_cents)}</strong>/mês ou {brl(p.price_yearly_cents)}/ano (contratação anual)</p>
        <ul><li>{p.limits.practitioners} médico(s)</li><li>{p.limits.locations} local(is)</li><li>{p.limits.members} colaborador(es) de equipe</li>
          <li>Lembretes: {p.features.reminders?.join(' e ')}{p.features.reminders?.includes('whatsapp') ? ' (WhatsApp depende de contratação do provedor oficial e cota)' : ''}</li>{p.features.reports && <li>Relatórios</li>}</ul>
      </article>))}</div>
    <p><Link className="btn" href="/cadastro?tipo=profissional">Começar teste gratuito</Link></p>
    <p className="small muted">Publicação do perfil depende de verificação manual do CRM e de teste ou assinatura vigente.</p></>);
}
