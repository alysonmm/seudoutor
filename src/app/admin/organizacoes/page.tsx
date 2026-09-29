import { adminShell } from '@/components/AdminShell';
import { query } from '@/server/db';

export const metadata = { title: 'Organizações' };

export default async function Orgs() {
  const { allowed, nav } = await adminShell('/admin/organizacoes', 'subscription.admin');
  // metadados de organização apenas; sem pacientes nem consultas
  const rows = allowed ? await query<any>(`SELECT o.id, o.name, o.kind, o.status, o.created_at, s.status sub_status,
      (SELECT count(*) FROM practitioner_memberships pm WHERE pm.organization_id=o.id AND pm.status='active')::int practitioners FROM organizations o
      LEFT JOIN subscriptions s ON s.organization_id=o.id AND s.status NOT IN ('cancelled','expired') ORDER BY o.created_at DESC LIMIT 200`) : [];
  return (<><h1>Organizações</h1>{nav}
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : rows.length === 0 ? <div className="empty">Nenhuma organização.</div> : (
      <div className="table-wrap"><table><thead><tr><th scope="col">Nome</th><th scope="col">Tipo</th><th scope="col">Situação</th><th scope="col">Assinatura</th><th scope="col">Profissionais</th></tr></thead>
        <tbody>{rows.map((o: any) => <tr key={o.id}><td>{o.name}</td><td>{o.kind}</td><td>{o.status}</td><td>{o.sub_status ?? '—'}</td><td>{o.practitioners}</td></tr>)}</tbody></table></div>)}
  </>);
}
