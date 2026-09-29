import Link from 'next/link';
import { requireUser } from '@/server/page-session';
import { listMyAppointments } from '@/server/modules/booking';

export const metadata = { title: 'Meus agendamentos' };
const label: Record<string, string> = { scheduled: 'Agendado', pending_approval: 'Aguardando autorização', cancelled: 'Cancelado', rescheduled: 'Reagendado', expired: 'Expirado', held: 'Reservado' };
const att: Record<string, string> = { unconfirmed: '', confirmed: 'presença confirmada', checked_in: 'chegada registrada', completed: 'concluída', no_show: 'falta registrada' };

export default async function Lista() {
  const s = await requireUser('/app/agendamentos');
  const all = await listMyAppointments(s.userId);
  return (
    <>
      <h1>Meus agendamentos</h1>
      {all.length === 0 ? <div className="empty">Nenhum agendamento ainda. <Link href="/buscar">Buscar médicos</Link></div> : (
        <div className="table-wrap"><table>
          <caption className="sr-only">Lista de agendamentos</caption>
          <thead><tr><th scope="col">Data</th><th scope="col">Profissional</th><th scope="col">Serviço</th><th scope="col">Situação</th></tr></thead>
          <tbody>{all.map((a: any) => (
            <tr key={a.id}>
              <td><Link href={`/app/agendamentos/${a.id}`}>{new Date(a.starts_at).toLocaleString('pt-BR', { timeZone: a.timezone, dateStyle: 'short', timeStyle: 'short' })}</Link></td>
              <td>{a.snapshot.practitioner.displayName}</td><td>{a.snapshot.service}</td>
              <td>{label[a.status]}{att[a.attendance] ? ` — ${att[a.attendance]}` : ''}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}
