import Link from 'next/link';
import { requireUser } from '@/server/page-session';
import JsonForm from '@/components/JsonForm';
import { listMyPrivacyRequests } from '@/server/modules/privacy';

export const metadata = { title: 'Privacidade' };
const kinds = [
  { value: 'access', label: 'Acesso aos meus dados' }, { value: 'correction', label: 'Correção' }, { value: 'portability', label: 'Exportação (portabilidade)' },
  { value: 'revocation', label: 'Revogação de consentimento' }, { value: 'erasure', label: 'Eliminação' }, { value: 'other', label: 'Outro' },
];

export default async function Privacidade() {
  const s = await requireUser('/app/privacidade');
  const reqs = await listMyPrivacyRequests(s.userId);
  return (
    <>
      <h1>Privacidade e meus dados</h1>
      <p>Leia o <Link href="/privacidade">Aviso de Privacidade</Link>. Cada pedido recebe protocolo e resposta fundamentada; alguns dados podem ser mantidos por obrigação legal ou defesa de direitos, com acesso restrito.</p>
      <section className="card"><h2>Baixar meus dados</h2><p><a className="btn" href="/api/v1/me/export" download="meus-dados.json">Exportar (JSON)</a></p></section>
      <section className="card"><h2>Novo pedido</h2>
        <JsonForm action="/api/v1/me/privacy-requests" submitLabel="Registrar pedido" successMessage="Pedido registrado. Acompanhe abaixo."
          fields={[{ name: 'kind', label: 'Tipo de pedido', type: 'select', required: true, options: kinds }, { name: 'details', label: 'Detalhes', type: 'textarea', help: 'Não inclua dados clínicos.' }]} /></section>
      <h2>Meus pedidos</h2>
      {reqs.length === 0 ? <div className="empty">Nenhum pedido registrado.</div> : (
        <div className="table-wrap"><table><thead><tr><th scope="col">Protocolo</th><th scope="col">Tipo</th><th scope="col">Situação</th><th scope="col">Prazo</th><th scope="col">Decisão</th></tr></thead>
          <tbody>{reqs.map((r: any) => <tr key={r.id}><td>{r.protocol}</td><td>{r.kind}</td><td>{r.status}</td><td>{new Date(r.due_at).toLocaleDateString('pt-BR')}</td><td>{r.decision ?? '—'}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}
