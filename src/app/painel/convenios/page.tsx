import { shell } from '@/components/PainelShell';
import JsonForm from '@/components/JsonForm';
import { listOfferings, listInsurers } from '@/server/modules/catalog';
import { query } from '@/server/db';

export const metadata = { title: 'Convênios' };

export default async function Convenios({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel/convenios');
  const offerings = await listOfferings(session.userId, org.id).catch(() => null);
  const insurers = await listInsurers();
  const accepted = offerings ? await query<any>(`SELECT a.practitioner_service_id, i.name insurer, ip.name product, a.requires_authorization, a.updated_at FROM accepted_insurance_products a JOIN insurance_products ip ON ip.id=a.insurance_product_id JOIN insurers i ON i.id=ip.insurer_id WHERE a.practitioner_service_id = ANY($1::uuid[])`, [offerings.map((o: any) => o.id)]) : [];
  const products = insurers.flatMap((i: any) => i.products.map((p: any) => ({ value: p.id, label: `${i.name} — ${p.name}` })));
  return (
    <>
      <h1>Convênios aceitos</h1>{nav}
      <p className="banner info">Cadastre operadora + <strong>produto</strong> por médico, local e serviço. “Aceita operadora” não garante cobertura de qualquer produto. Informe se exige autorização: a solicitação do paciente ficará pendente até a sua resposta. O catálogo de operadoras/produtos é mantido pela administração.</p>
      {offerings === null ? <div className="banner">Sem permissão.</div> : offerings.length === 0 ? <div className="empty">Cadastre um serviço antes.</div> : offerings.map((o: any) => (
        <section className="card" key={o.id}><h2>{o.service_name} — {o.location_name}</h2>
          <ul>{accepted.filter((a: any) => a.practitioner_service_id === o.id).map((a: any) => <li key={a.product}>{a.insurer} — {a.product}{a.requires_authorization ? ' (exige autorização)' : ''} • atualizado em {new Date(a.updated_at).toLocaleDateString('pt-BR')}</li>)}</ul>
          {products.length === 0 ? <p className="muted">Nenhum produto no catálogo ainda.</p> : (
            <JsonForm action={`/api/v1/organizations/${org.id}/offerings/${o.id}/insurance`} method="PUT" submitLabel="Definir convênio aceito (substitui a lista)"
              fields={[{ name: 'items.0.insuranceProductId', label: 'Operadora / produto', type: 'select', required: true, options: products }, { name: 'items.0.requiresAuthorization', label: 'Exige autorização prévia', type: 'checkbox' }]} />)}
        </section>))}
    </>
  );
}
