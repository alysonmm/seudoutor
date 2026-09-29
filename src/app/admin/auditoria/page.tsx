import { adminShell } from '@/components/AdminShell';
import { listAudit } from '@/server/modules/incidents';

export const metadata = { title: 'Auditoria' };

export default async function Aud({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { session, allowed, nav } = await adminShell('/admin/auditoria', 'audit.read');
  const rows: any[] = allowed ? await listAudit(session.userId, { action: sp.acao || undefined, limit: 200 }) : [];
  return (<><h1>Trilha de auditoria</h1>{nav}
    <p className="small">Somente leitura e append-only. A própria consulta é registrada.</p>
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : (<>
      <form method="get" className="row"><label htmlFor="acao">Ação</label><input id="acao" name="acao" defaultValue={sp.acao} style={{ width: 'auto' }} placeholder="ex.: export.downloaded" /><button className="secondary" type="submit">Filtrar</button></form>
      {rows.length === 0 ? <div className="empty">Sem registros.</div> : <div className="table-wrap"><table><thead><tr><th scope="col">Quando</th><th scope="col">Ator</th><th scope="col">Ação</th><th scope="col">Objeto</th><th scope="col">Motivo</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td>{new Date(r.at).toLocaleString('pt-BR')}</td><td>{r.actor_kind}{r.actor_user_id ? ' ' + String(r.actor_user_id).slice(0, 8) : ''}</td><td>{r.action}</td><td>{r.object_type} {r.object_id ? String(r.object_id).slice(0, 8) : ''}</td><td>{r.reason ?? ''}</td></tr>)}</tbody></table></div>}</>)}
  </>);
}
