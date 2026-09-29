import { shell } from '@/components/PainelShell';
import JsonForm from '@/components/JsonForm';
import { getSubscription, listPlans } from '@/server/modules/billing';
import Link from 'next/link';

export const metadata = { title: 'Assinatura' };
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const st: Record<string, string> = { pending: 'Pendente de pagamento', trialing: 'Em teste gratuito', active: 'Ativa', past_due: 'Em atraso (recursos novos restritos)', grace_period: 'Em carência', cancel_at_period_end: 'Cancelamento agendado', cancelled: 'Cancelada', expired: 'Expirada' };

export default async function Assinatura({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel/assinatura');
  const data = await getSubscription(session.userId, org.id).catch(() => null);
  const plans = await listPlans();
  const s = data?.subscription;
  const live = s && !['cancelled', 'expired'].includes(s.status);
  return (
    <>
      <h1>Assinatura</h1>{nav}
      {data === null ? <div className="banner">Somente gestores e financeiro veem a assinatura.</div> : (<>
        <section className="card"><h2>Situação</h2>
          {!s ? <p>Sem assinatura. Inicie o teste gratuito (sem cartão) ou contrate.</p> : (<>
            <p><span className="badge">{st[s.status]}</span> Plano {s.plan_id} v{s.version} — {brl(s.amount_cents)} / {s.billing_period === 'monthly' ? 'mês' : 'ano'}</p>
            {s.trial_ends_at && s.status === 'trialing' && <p>O teste termina em {new Date(s.trial_ends_at).toLocaleDateString('pt-BR')}. Depois, a continuidade depende de contratação expressa.</p>}
            {s.current_period_end && <p>Período vigente até {new Date(s.current_period_end).toLocaleDateString('pt-BR')}.</p>}
            {s.status === 'pending' && <p className="banner">Aguardando confirmação do pagamento pelo provedor. Voltar do checkout não ativa a assinatura.</p>}
          </>)}
          {live && s.status !== 'cancel_at_period_end' && <JsonForm action={`/api/v1/organizations/${org.id}/subscription`} method="DELETE" fields={[]} submitLabel="Cancelar assinatura" secondary confirmText="Cancelar a assinatura? Você recebe comprovante com a data de efeito." successMessage="Cancelamento registrado." />}
          {s && <JsonForm action={`/api/v1/organizations/${org.id}/subscription/refund-requests`} submitLabel="Solicitar arrependimento/restituição" secondary successMessage="Solicitação registrada; será analisada conforme o contrato e a lei."
            fields={[{ name: 'kind', label: 'Tipo', type: 'select', required: true, options: [{ value: 'withdrawal', label: 'Arrependimento' }, { value: 'refund', label: 'Restituição' }, { value: 'other', label: 'Outro' }] }, { name: 'reason', label: 'Motivo', type: 'textarea' }]} />}
        </section>
        {data.invoices.length > 0 && <section className="card"><h2>Recibos</h2><ul>{data.invoices.map((i: any) => <li key={i.id}>{new Date(i.period_start).toLocaleDateString('pt-BR')} — {brl(i.amount_cents)} — {i.status} — {i.receipt_number ?? ''} <span className="small muted">(recibo operacional, não é nota fiscal)</span></li>)}</ul></section>}
        {!live && (
          <section><h2>Planos</h2><p className="banner info">Valores são <strong>hipóteses de teste</strong>. O total, a periodicidade e a renovação automática aparecem antes da contratação. Sem cobrança de excedente automática. <Link href="/planos">Detalhes</Link></p>
            <div className="grid cols-3">{plans.map((p: any) => (
              <article className="card" key={p.plan_id}><h3>{p.name}</h3>
                <p>{brl(p.price_monthly_cents)}/mês • {brl(p.price_yearly_cents)}/ano</p>
                <JsonForm action={`/api/v1/organizations/${org.id}/subscription`} fixed={{ planId: p.plan_id }} submitLabel="Iniciar teste gratuito" successMessage="Teste iniciado." refresh
                  fields={[{ name: 'period', label: 'Periodicidade', type: 'select', required: true, options: [{ value: 'monthly', label: 'Mensal' }, { value: 'yearly', label: 'Anual (cobrança única do total anual)' }] }, { name: 'startTrial', label: 'Começar pelo teste gratuito (sem cartão)', type: 'checkbox', defaultValue: true }, { name: 'acceptContract', label: 'Aceito o contrato (minuta em revisão)', type: 'checkbox' }]} />
              </article>))}</div></section>)}
      </>)}
    </>
  );
}
