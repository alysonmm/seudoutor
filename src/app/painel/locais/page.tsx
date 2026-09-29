import { shell } from '@/components/PainelShell';
import JsonForm from '@/components/JsonForm';
import { listLocations } from '@/server/modules/catalog';

export const metadata = { title: 'Locais' };

export default async function Locais({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel/locais');
  const locs = await listLocations(session.userId, org.id).catch(() => null);
  return (
    <>
      <h1>Locais de atendimento</h1>{nav}
      {locs === null ? <div className="banner">Sem permissão.</div> : locs.length === 0 ? <div className="empty">Nenhum local cadastrado.</div> : (
        <div className="table-wrap"><table><thead><tr><th scope="col">Nome</th><th scope="col">Endereço</th><th scope="col">Fuso</th><th scope="col">Coordenadas</th></tr></thead>
          <tbody>{locs.map((l: any) => <tr key={l.id}><td>{l.name}</td><td>{l.street}{l.number ? ', ' + l.number : ''} — {l.neighborhood}, {l.city}/{l.uf}</td><td>{l.timezone}</td><td>{l.latitude != null ? `${l.latitude}, ${l.longitude}` : 'não informadas (sem cálculo de distância)'}</td></tr>)}</tbody></table></div>
      )}
      <section className="card"><h2>Novo local</h2>
        <JsonForm action={`/api/v1/organizations/${org.id}/locations`} submitLabel="Adicionar local"
          fields={[
            { name: 'name', label: 'Nome do local', required: true }, { name: 'street', label: 'Rua', required: true }, { name: 'number', label: 'Número' }, { name: 'complement', label: 'Complemento' },
            { name: 'neighborhood', label: 'Bairro', required: true }, { name: 'city', label: 'Cidade', required: true }, { name: 'uf', label: 'UF', required: true, maxLength: 2 }, { name: 'postalCode', label: 'CEP' },
            { name: 'latitude', label: 'Latitude', type: 'number', help: 'Geocodificação automática não está integrada; informe manualmente para habilitar distância.' }, { name: 'longitude', label: 'Longitude', type: 'number' },
            { name: 'timezone', label: 'Fuso horário (IANA)', defaultValue: 'America/Sao_Paulo' }, { name: 'accessibility', label: 'Acessibilidade (separe por vírgula)', type: 'list' },
            { name: 'arrivalInstructions', label: 'Como chegar', type: 'textarea' }, { name: 'adminPhone', label: 'Telefone administrativo' },
          ]} /></section>
    </>
  );
}
