import { adminShell } from '@/components/AdminShell';
import JsonForm from '@/components/JsonForm';
import { listIncidents } from '@/server/modules/incidents';

export const metadata = { title: 'Incidentes' };

export default async function Inc() {
  const { session, allowed, nav } = await adminShell('/admin/incidentes', 'incident.manage');
  const rows: any[] = allowed ? await listIncidents(session.userId) : [];
  return (<><h1>Incidentes de segurança</h1>{nav}
    <p className="banner info">O relógio usa 3 dias úteis a partir da ciência de afetação de dados pessoais (referência J8; feriados não considerados). É apoio operacional: a decisão de comunicar é do responsável jurídico/privacidade.</p>
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : (<>
      {rows.length === 0 ? <div className="empty">Nenhum incidente.</div> : <div className="table-wrap"><table><thead><tr><th scope="col">Título</th><th scope="col">Gravidade</th><th scope="col">Situação</th><th scope="col">Prazo de comunicação</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{r.title}</td><td>{r.severity}</td><td>{r.status}</td><td>{r.communication_due_at ? new Date(r.communication_due_at).toLocaleString('pt-BR') : 'n/a'} {r.overdue && <span className="badge bad">vencido</span>}</td></tr>)}</tbody></table></div>}
      <section className="card"><h2>Registrar incidente</h2>
        <JsonForm action="/api/v1/admin/incidents" submitLabel="Registrar" fields={[
          { name: 'title', label: 'Título', required: true }, { name: 'severity', label: 'Gravidade', type: 'select', required: true, options: ['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v })) },
          { name: 'detectedAt', label: 'Detectado em', type: 'datetime-local', required: true }, { name: 'awarenessAt', label: 'Ciência de afetação em', type: 'datetime-local', required: true },
          { name: 'affectsPersonalData', label: 'Afeta dados pessoais', type: 'checkbox' }, { name: 'owner', label: 'Responsável' }]} /></section></>)}
  </>);
}
