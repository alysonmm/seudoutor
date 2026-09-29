import { adminShell } from '@/components/AdminShell';
import { query } from '@/server/db';

export const metadata = { title: 'Suporte' };

export default async function Sup() {
  const { allowed, nav } = await adminShell('/admin/suporte', 'support.ticket');
  // metadados mínimos: sem corpo da mensagem nem dados do paciente; acesso excepcional exige grant registrado (não há "entrar como")
  const rows = allowed ? await query<any>("SELECT protocol, subject, status, created_at FROM support_tickets ORDER BY created_at DESC LIMIT 200") : [];
  return (<><h1>Suporte</h1>{nav}
    <p className="banner info">Visão de metadados mínimos. Acesso excepcional a dados de um titular exige motivo, ticket, prazo e aprovação de outra pessoa (tabela de grants) e fica na auditoria.</p>
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : rows.length === 0 ? <div className="empty">Nenhum ticket.</div> : (
      <div className="table-wrap"><table><thead><tr><th scope="col">Protocolo</th><th scope="col">Assunto</th><th scope="col">Situação</th><th scope="col">Abertura</th></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.protocol}><td>{r.protocol}</td><td>{r.subject}</td><td>{r.status}</td><td>{new Date(r.created_at).toLocaleString('pt-BR')}</td></tr>)}</tbody></table></div>)}
  </>);
}
