import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DateTime } from 'luxon';
import { requireUser } from '@/server/page-session';
import { getMyAppointment } from '@/server/modules/booking';
import { one } from '@/server/db';
import { computeSlots, loadOffering } from '@/server/modules/availability';
import JsonForm from '@/components/JsonForm';

export const metadata = { title: 'Agendamento' };
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default async function Detalhe({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await requireUser(`/app/agendamentos/${id}`);
  const a: any = await getMyAppointment(s.userId, id).catch(() => null);
  if (!a) notFound();
  const snap = a.snapshot;
  const active = ['scheduled', 'pending_approval'].includes(a.status) && new Date(a.starts_at) > new Date();
  let options: { value: string; label: string }[] = [];
  if (active) {
    const row = await one<{ practitioner_service_id: string }>('SELECT practitioner_service_id FROM appointments WHERE id=$1', [id]);
    const o = row && (await loadOffering(row.practitioner_service_id));
    if (o) {
      const slots = await computeSlots(o, DateTime.now().setZone(o.timezone).toISODate()!, DateTime.now().setZone(o.timezone).plus({ days: 21 }).toISODate()!, { excludeAppointmentId: id });
      options = slots.slice(0, 60).map((x) => ({ value: x.startsAt, label: `${x.localDate.split('-').reverse().join('/')} ${x.localTime}` }));
    }
  }
  const done = a.attendance === 'completed';
  return (
    <>
      <h1>Agendamento</h1>
      <div className="card">
        <p><strong>{new Date(a.starts_at).toLocaleString('pt-BR', { timeZone: a.timezone, dateStyle: 'full', timeStyle: 'short' })}</strong> ({a.timezone})</p>
        <p>{snap.practitioner.displayName} — {snap.practitioner.registration} — {snap.practitioner.specialties.join(', ')}</p>
        <p>{snap.service} ({snap.durationMinutes} min) • {snap.payer === 'private' ? (snap.priceInformed ? brl(snap.priceCents) + ' (particular)' : 'particular — valor não informado') : `Convênio: ${snap.insurance?.insurer} — ${snap.insurance?.product}`} • pagamento {snap.paymentAt}</p>
        <p>{snap.location.address}</p>
        {snap.conditions && <p className="small">Condições: {snap.conditions}</p>}
        <p><span className="badge">{a.status === 'scheduled' ? 'Agendado' : a.status === 'pending_approval' ? 'Aguardando autorização' : a.status === 'cancelled' ? 'Cancelado' : a.status}</span> <span className="badge">{a.attendance}</span></p>
        <p className="small muted">Valores e condições acima são os apresentados no momento da contratação. “Concluída” é um registro administrativo.</p>
      </div>

      {active && (
        <>
          <section className="card"><h2>Confirmar presença</h2>
            <JsonForm action={`/api/v1/appointments/${id}/confirm`} fields={[]} submitLabel={a.attendance === 'confirmed' ? 'Presença já confirmada' : 'Confirmar presença'} successMessage="Presença confirmada." /></section>
          <section className="card"><h2>Reagendar</h2>
            {options.length === 0 ? <p className="muted">Não há outros horários abertos nas próximas semanas.</p> : (
              <JsonForm action={`/api/v1/appointments/${id}/reschedule`} idempotent submitLabel="Reagendar"
                fields={[{ name: 'startsAt', label: 'Novo horário', type: 'select', required: true, options }]}
                successMessage="Reagendado. Abra a lista de agendamentos para ver o novo horário." redirectTo="/app/agendamentos" />)}
            <p className="small">Se o novo horário falhar, seu agendamento atual é mantido.</p></section>
          <section className="card"><h2>Cancelar</h2>
            <JsonForm action={`/api/v1/appointments/${id}/cancel`} submitLabel="Cancelar agendamento" secondary confirmText="Cancelar este agendamento?" redirectTo="/app/agendamentos"
              fields={[{ name: 'reason', label: 'Motivo (opcional, sem dados clínicos)', type: 'text', maxLength: 200 }]} />
            <p className="small">Sem multa automática. <Link href="/cancelamentos">Política de cancelamentos</Link>.</p></section>
        </>
      )}
      {a.needs_followup && <div className="banner">A clínica precisa entrar em contato sobre este agendamento. {a.followup_reason}</div>}
      {a.attendance === 'no_show' && (
        <section className="card"><h2>Contestar falta registrada</h2>
          <JsonForm action={`/api/v1/appointments/${id}/contest`} submitLabel="Enviar contestação" fields={[{ name: 'message', label: 'O que houve?', type: 'textarea', required: true, help: 'Não inclua dados clínicos.' }]} /></section>
      )}
      {done && (
        <section className="card"><h2>Feedback privado</h2>
          <p className="small">Seu feedback é privado e ajuda a melhorar a experiência administrativa (pontualidade, comunicação e estrutura). Não escreva diagnósticos, nomes de terceiros ou documentos.</p>
          <JsonForm action={`/api/v1/me/appointments/${id}/feedback`} submitLabel="Enviar feedback" successMessage="Feedback registrado (privado)."
            fields={[
              { name: 'punctuality', label: 'Pontualidade (1 a 5)', type: 'number', required: true }, { name: 'communication', label: 'Comunicação administrativa (1 a 5)', type: 'number', required: true },
              { name: 'structure', label: 'Estrutura (1 a 5)', type: 'number', required: true }, { name: 'comment', label: 'Comentário (opcional)', type: 'textarea', maxLength: 1000 }]} /></section>
      )}
      <h2>Histórico</h2>
      <ul>{a.events.map((e: any, i: number) => <li key={i}>{new Date(e.at).toLocaleString('pt-BR')} — {e.type}</li>)}</ul>
      <p><Link href="/app/agendamentos">← Voltar</Link></p>
    </>
  );
}
