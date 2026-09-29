import { DateTime } from 'luxon';
import { shell } from '@/components/PainelShell';
import { listOrgAppointments } from '@/server/modules/booking';
import { authorizeOrg } from '@/server/modules/authz';
import { query } from '@/server/db';
import JsonForm from '@/components/JsonForm';

export const metadata = { title: 'Agenda' };

export default async function Agenda({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav, sp } = await shell(searchParams, '/painel/agenda');
  const from = sp.data ? DateTime.fromISO(sp.data, { zone: 'America/Sao_Paulo' }).startOf('day') : DateTime.now().setZone('America/Sao_Paulo').startOf('day');
  const to = from.plus({ days: 7 });
  const appts = await listOrgAppointments(session.userId, org.id, from.toISO()!, to.toISO()!).catch(() => null);
  const g = await authorizeOrg(session.userId, org.id, 'appointment.create').catch(() => null);
  const op: unknown[] = [org.id];
  const offerings = g ? await query<any>(
    `SELECT ps.id, s.name sname, l.name lname, v.data->>'display_name' pname FROM practitioner_services ps JOIN services s ON s.id=ps.service_id JOIN locations l ON l.id=ps.location_id
       JOIN practitioners p ON p.id=ps.practitioner_id LEFT JOIN public_profile_versions v ON v.id=p.current_public_version_id
      WHERE ps.organization_id=$1 AND ps.active AND ${g.sql('ps', op)}`, op).catch(() => []) : [];
  return (
    <>
      <h1>Agenda</h1>{nav}
      <form method="get" className="row"><input type="hidden" name="org" value={org.id} /><label htmlFor="data">Semana a partir de</label><input id="data" name="data" type="date" defaultValue={from.toISODate()!} style={{ width: 'auto' }} /><button type="submit" className="secondary">Ver</button></form>
      {appts === null ? <div className="banner">Sem permissão para ver a agenda.</div> : appts.length === 0 ? <div className="empty">Nenhum agendamento neste período.</div> : (
        <div className="table-wrap"><table><caption className="sr-only">Agendamentos da semana</caption>
          <thead><tr><th scope="col">Quando</th><th scope="col">Paciente</th><th scope="col">Serviço</th><th scope="col">Origem</th><th scope="col">Situação</th><th scope="col">Ações</th></tr></thead>
          <tbody>{appts.map((a: any) => (
            <tr key={a.id}>
              <td>{new Date(a.starts_at).toLocaleString('pt-BR', { timeZone: a.timezone, dateStyle: 'short', timeStyle: 'short' })}</td>
              <td>{a.patient_name}</td><td>{a.service}</td><td>{a.source}</td>
              <td>{a.status} / {a.attendance}{a.needs_followup ? ' — contatar paciente' : ''}</td>
              <td>{['scheduled', 'pending_approval'].includes(a.status) && (
                <div className="row">
                  {a.status === 'pending_approval' && <JsonForm action={`/api/v1/appointments/${a.id}/approve`} fields={[]} submitLabel="Aprovar" />}
                  {a.status === 'scheduled' && new Date(a.starts_at) < new Date() && <>
                    <JsonForm action={`/api/v1/appointments/${a.id}/complete`} fields={[]} submitLabel="Concluída" />
                    <JsonForm action={`/api/v1/appointments/${a.id}/no-show`} fields={[]} submitLabel="Falta" secondary confirmText="Registrar falta?" /></>}
                  {a.status === 'scheduled' && new Date(a.starts_at) >= new Date() && <JsonForm action={`/api/v1/appointments/${a.id}/check-in`} fields={[]} submitLabel="Chegou" secondary />}
                  <JsonForm action={`/api/v1/appointments/${a.id}/cancel`} fields={[]} submitLabel="Cancelar" secondary confirmText="Cancelar este agendamento? O paciente será avisado." />
                </div>)}</td>
            </tr>))}</tbody></table></div>
      )}
      {g && (
        <section className="card" aria-labelledby="man"><h2 id="man">Registrar agendamento (telefone, WhatsApp ou recepção)</h2>
          <p className="small">Cria um registro restrito a esta organização. Não cria senha nem aceite pelo paciente. Ocupa apenas horários realmente livres.</p>
          <JsonForm action={`/api/v1/organizations/${org.id}/appointments`} submitLabel="Registrar"
            fields={[
              { name: 'offeringId', label: 'Serviço/médico/local', type: 'select', required: true, options: offerings.map((o: any) => ({ value: o.id, label: `${o.pname ?? 'Profissional'} — ${o.sname} — ${o.lname}` })) },
              { name: 'startsAt', label: 'Data e hora', type: 'datetime-local', required: true, help: 'Precisa coincidir com um horário oferecido pela agenda.' },
              { name: 'source', label: 'Origem', type: 'select', required: true, options: [{ value: 'phone', label: 'Telefone' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'reception', label: 'Recepção' }] },
              { name: 'patient.fullName', label: 'Nome do paciente', required: true }, { name: 'patient.phone', label: 'Telefone' }, { name: 'patient.email', label: 'E-mail (para convite de vínculo)', type: 'email' },
            ]} /></section>
      )}
    </>
  );
}
