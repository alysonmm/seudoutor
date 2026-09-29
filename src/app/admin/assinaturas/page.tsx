import { adminShell } from '@/components/AdminShell';
import { query } from '@/server/db';
import { listPlans } from '@/server/modules/billing';

export const metadata = { title: 'Assinaturas' };
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default async function Subs() {
  const { allowed, nav } = await adminShell('/admin/assinaturas', 'subscription.admin');
  const plans = allowed ? await listPlans() : [];
  const rows = allowed ? await query<any>(`SELECT s.id, o.name, pv.plan_id, pv.version, s.billing_period, s.status, s.amount_cents, s.current_period_end, s.grace_ends_at FROM subscriptions s JOIN organizations o ON o.id=s.organization_id JOIN plan_versions pv ON pv.id=s.plan_version_id ORDER BY s.updated_at DESC LIMIT 200`) : [];
  const refunds = allowed ? await query<any>("SELECT protocol, kind, status, created_at FROM refund_requests WHERE status='open' ORDER BY created_at") : [];
  return (<><h1>Assinaturas</h1>{nav}
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : (<>
      <h2>Planos vigentes (hipóteses de teste)</h2>
      <ul>{plans.map((p: any) => <li key={p.plan_id}>{p.name} v{p.version}: {brl(p.price_monthly_cents)}/mês, {brl(p.price_yearly_cents)}/ano — limites {JSON.stringify(p.limits)}</li>)}</ul>
      <h2>Assinaturas</h2>
      {rows.length === 0 ? <div className="empty">Nenhuma assinatura.</div> : <div className="table-wrap"><table><thead><tr><th scope="col">Organização</th><th scope="col">Plano</th><th scope="col">Periodicidade</th><th scope="col">Situação</th><th scope="col">Valor</th><th scope="col">Fim do período</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.id}><td>{r.name}</td><td>{r.plan_id} v{r.version}</td><td>{r.billing_period}</td><td>{r.status}</td><td>{brl(r.amount_cents)}</td><td>{r.current_period_end ? new Date(r.current_period_end).toLocaleDateString('pt-BR') : '—'}</td></tr>)}</tbody></table></div>}
      <h2>Arrependimento / restituição em aberto</h2>
      {refunds.length === 0 ? <div className="empty">Nada em aberto.</div> : <ul>{refunds.map((r: any) => <li key={r.protocol}>{r.protocol} — {r.kind}</li>)}</ul>}</>)}
  </>);
}
