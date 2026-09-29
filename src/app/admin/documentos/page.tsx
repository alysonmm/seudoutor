import { adminShell } from '@/components/AdminShell';
import { query } from '@/server/db';

export const metadata = { title: 'Documentos legais' };

export default async function Docs() {
  const { allowed, nav } = await adminShell('/admin/documentos', 'feature.manage');
  const rows = allowed ? await query<any>("SELECT d.key, d.title, v.version, v.status, v.approved_by, v.approved_at, substr(v.content_hash,1,12) h FROM legal_documents d JOIN document_versions v ON v.document_id=d.id ORDER BY d.key, v.version DESC") : [];
  return (<><h1>Documentos legais</h1>{nav}
    <p className="banner">Todas as versões atuais são <strong>MINUTAS — REVISÃO JURÍDICA PENDENTE</strong>. A publicação exige aprovador humano registrado (nome e data); o sistema não aprova por conta própria e, em produção, bloqueia o cadastro sem versão publicada.</p>
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : (
      <div className="table-wrap"><table><thead><tr><th scope="col">Documento</th><th scope="col">Versão</th><th scope="col">Situação</th><th scope="col">Aprovado por</th><th scope="col">Hash</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.key + r.version}><td>{r.title}</td><td>{r.version}</td><td>{r.status === 'draft_minuta' ? 'Minuta (não aprovada)' : r.status}</td><td>{r.approved_by ?? '—'}</td><td><code>{r.h}</code></td></tr>)}</tbody></table></div>)}
  </>);
}
