import { adminShell } from '@/components/AdminShell';
import { query } from '@/server/db';

export const metadata = { title: 'Moderação' };

export default async function Mod() {
  const { allowed, nav } = await adminShell('/admin/moderacao', 'moderation.review');
  const rows = allowed ? await query<any>("SELECT id, subject_type, reason, status, due_at, created_at FROM moderation_cases ORDER BY status, due_at NULLS LAST LIMIT 200") : [];
  return (<><h1>Moderação</h1>{nav}
    <p className="banner info">Avaliações são privadas neste piloto; casos sinalizados aguardam análise humana com prazo interno e decisão registrada. Nada é publicado automaticamente.</p>
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : rows.length === 0 ? <div className="empty">Nenhum caso.</div> : (
      <div className="table-wrap"><table><thead><tr><th scope="col">Tipo</th><th scope="col">Motivo</th><th scope="col">Situação</th><th scope="col">Prazo interno</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.id}><td>{r.subject_type}</td><td>{r.reason}</td><td>{r.status}</td><td>{r.due_at ? new Date(r.due_at).toLocaleDateString('pt-BR') : '—'}</td></tr>)}</tbody></table></div>)}
  </>);
}
