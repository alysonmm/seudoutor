import { adminShell } from '@/components/AdminShell';
import { adminMetrics, adminSpecialtyDistribution } from '@/server/modules/reports';

export const metadata = { title: 'Administração' };
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default async function Admin() {
  const { session, allowed, nav } = await adminShell('/admin', 'subscription.admin');
  const m = allowed ? await adminMetrics(session.userId) : null;
  const sp = allowed ? await adminSpecialtyDistribution(session.userId) : [];
  return (<><h1>Administração</h1>{nav}
    {!m ? <div className="banner">Seu papel não tem permissão para esta área.</div> : (<>
      <div className="grid cols-3">
        <div className="card"><div className="small muted">MRR (recorrência normalizada)</div><strong style={{ fontSize: '1.6rem' }}>{brl(m.mrrCents)}</strong><div className="small muted">Anual ÷ 12; teste gratuito e valor das consultas não entram.</div></div>
        <div className="card"><div className="small muted">Assinaturas pagantes</div><strong style={{ fontSize: '1.6rem' }}>{m.payingSubscriptions}</strong></div>
        <div className="card"><div className="small muted">Em teste</div><strong style={{ fontSize: '1.6rem' }}>{m.trialing}</strong></div>
        <div className="card"><div className="small muted">Inadimplência (carência/atraso)</div><strong style={{ fontSize: '1.6rem' }}>{m.delinquent}</strong></div>
        <div className="card"><div className="small muted">Organizações ativas</div><strong style={{ fontSize: '1.6rem' }}>{m.activeOrganizations}</strong></div>
        <div className="card"><div className="small muted">Fila de credenciamento</div><strong style={{ fontSize: '1.6rem' }}>{m.credentialingQueue}</strong></div>
        <div className="card"><div className="small muted">Tickets abertos</div><strong style={{ fontSize: '1.6rem' }}>{m.openTickets}</strong></div>
        <div className="card"><div className="small muted">Incidentes abertos</div><strong style={{ fontSize: '1.6rem' }}>{m.openIncidents}</strong></div>
      </div>
      <h2>Profissionais aprovados por especialidade</h2><p className="small muted">Grupos pequenos são suprimidos. Não há feed de consultas individuais.</p>
      <ul>{sp.map((s: any) => <li key={s.name}>{s.name}: {s.suppressed ? 'suprimido (grupo pequeno)' : s.count}</li>)}</ul></>)}
  </>);
}
