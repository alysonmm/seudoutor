import { DateTime } from 'luxon';
import { shell } from '@/components/PainelShell';
import JsonForm from '@/components/JsonForm';
import { authorizeOrg } from '@/server/modules/authz';
import { query } from '@/server/db';
import { listOfferings } from '@/server/modules/catalog';
import { listRules } from '@/server/modules/availability';

export const metadata = { title: 'Serviços e horários' };
const brl = (c: number | null) => (c == null ? 'não informado' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const dias = ['', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

export default async function Servicos({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel/servicos');
  const offerings = await listOfferings(session.userId, org.id).catch(() => null);
  const canServ = await authorizeOrg(session.userId, org.id, 'org.services.manage').then(() => true).catch(() => false);
  const canSched = await authorizeOrg(session.userId, org.id, 'schedule.manage').then(() => true).catch(() => false);
  const [pracs, locs, svcs] = await Promise.all([
    query<any>(`SELECT p.id, COALESCE(p.display_name, 'Profissional sem nome') name FROM practitioners p JOIN practitioner_memberships pm ON pm.practitioner_id=p.id WHERE pm.organization_id=$1 AND pm.status='active'`, [org.id]),
    query<any>('SELECT id, name FROM locations WHERE organization_id=$1 AND active ORDER BY name', [org.id]),
    query<any>('SELECT id, name FROM services WHERE organization_id=$1 AND active ORDER BY name', [org.id]),
  ]);
  const rulesByP = canSched ? await Promise.all(pracs.map(async (p: any) => ({ p, rules: await listRules(session.userId, org.id, p.id).catch(() => []) }))) : [];
  const opt = (rows: any[]) => rows.map((r) => ({ value: r.id, label: r.name }));
  return (
    <>
      <h1>Serviços, preços e horários</h1>{nav}
      <h2>Ofertas</h2>
      {offerings === null ? <div className="banner">Sem permissão.</div> : offerings.length === 0 ? <div className="empty">Nenhum serviço cadastrado.</div> : (
        <div className="table-wrap"><table><thead><tr><th scope="col">Serviço</th><th scope="col">Local</th><th scope="col">Duração</th><th scope="col">Preço particular</th></tr></thead>
          <tbody>{offerings.map((o: any) => <tr key={o.id}><td>{o.service_name}</td><td>{o.location_name}</td><td>{o.duration_minutes} min (+{o.prep_minutes} preparo, +{o.buffer_minutes} intervalo)</td><td>{brl(o.price_cents)}</td></tr>)}</tbody></table></div>
      )}
      {canServ && (<>
        <section className="card"><h2>Novo tipo de serviço</h2><JsonForm action={`/api/v1/organizations/${org.id}/services`} submitLabel="Criar serviço" fields={[{ name: 'name', label: 'Nome (ex.: Consulta)', required: true }]} /></section>
        <section className="card"><h2>Oferecer serviço (médico + local)</h2>
          <p className="small">Deixe o preço em branco quando não quiser informar: será exibido como “valor não informado”, nunca como R$ 0. Alterar o preço não muda agendamentos já feitos.</p>
          <JsonForm action={`/api/v1/organizations/${org.id}/offerings`} submitLabel="Salvar oferta"
            fields={[
              { name: 'practitionerId', label: 'Médico', type: 'select', required: true, options: opt(pracs) }, { name: 'locationId', label: 'Local', type: 'select', required: true, options: opt(locs) },
              { name: 'serviceId', label: 'Serviço', type: 'select', required: true, options: opt(svcs) },
              { name: 'durationMinutes', label: 'Duração (min)', type: 'number', required: true, defaultValue: 30 }, { name: 'prepMinutes', label: 'Preparo antes (min)', type: 'number', defaultValue: 0 },
              { name: 'bufferMinutes', label: 'Intervalo depois (min)', type: 'number', defaultValue: 0 }, { name: 'priceCents', label: 'Preço particular em centavos (ex.: 25000 = R$ 250,00)', type: 'number', inputMode: 'numeric' },
              { name: 'paymentMethods', label: 'Formas de pagamento no local (vírgula)', type: 'list' }, { name: 'conditions', label: 'Condições', type: 'textarea' },
              { name: 'returnPolicy', label: 'Política de retorno (sujeita a revisão)', type: 'textarea' },
            ]} /></section></>)}
      {canSched && (<>
        <h2>Horários de atendimento</h2>
        {rulesByP.map(({ p, rules }: any) => (
          <section className="card" key={p.id}><h3>{p.name}</h3>
            {rules.length === 0 ? <p className="muted">Sem regras: nenhum horário é oferecido.</p> : (
              <ul>{rules.map((r: any) => <li key={r.id}>{dias[r.weekday]} {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)} (a cada {r.slot_step_minutes} min)
                <JsonForm action={`/api/v1/organizations/${org.id}/availability/rules/${r.id}`} method="DELETE" fields={[]} submitLabel="Remover" secondary confirmText="Remover esta regra? Se houver consultas afetadas, você será avisado." /></li>)}</ul>)}
            <JsonForm action={`/api/v1/organizations/${org.id}/availability/rules`} submitLabel="Adicionar regra semanal" fixed={{ practitionerId: p.id }}
              fields={[{ name: 'locationId', label: 'Local', type: 'select', required: true, options: opt(locs) },
                { name: 'weekday', label: 'Dia (1=segunda … 7=domingo)', type: 'number', required: true }, { name: 'startTime', label: 'Início', type: 'time', required: true }, { name: 'endTime', label: 'Fim', type: 'time', required: true },
                { name: 'slotStepMinutes', label: 'Intervalo entre horários (min)', type: 'number', defaultValue: 15 }]} />
            <JsonForm action={`/api/v1/organizations/${org.id}/availability/exceptions`} submitLabel="Data especial (feriado/janela)" secondary fixed={{ practitionerId: p.id }}
              fields={[{ name: 'locationId', label: 'Local', type: 'select', required: true, options: opt(locs) }, { name: 'onDate', label: 'Data', type: 'date', required: true },
                { name: 'kind', label: 'Tipo', type: 'select', required: true, options: [{ value: 'closed', label: 'Fechado o dia todo' }, { value: 'open', label: 'Janela especial (substitui a recorrência)' }] },
                { name: 'startTime', label: 'Início (se janela)', type: 'time' }, { name: 'endTime', label: 'Fim (se janela)', type: 'time' }]} />
            <JsonForm action={`/api/v1/organizations/${org.id}/availability/blocks`} submitLabel="Bloquear período (férias, ausência)" secondary fixed={{ practitionerId: p.id }}
              fields={[{ name: 'startsAt', label: 'De', type: 'datetime-local', required: true }, { name: 'endsAt', label: 'Até', type: 'datetime-local', required: true }, { name: 'reason', label: 'Motivo interno' }]} />
          </section>))}
      </>)}
      <p className="small muted">Hoje: {DateTime.now().setZone('America/Sao_Paulo').toFormat('dd/LL/yyyy')}.</p>
    </>
  );
}
