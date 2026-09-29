import Link from 'next/link';
import { requireUser } from '@/server/page-session';
import { listMyAppointments } from '@/server/modules/booking';

export const metadata = { title: 'Minha área' };

export default async function Area() {
  const s = await requireUser('/app');
  const all = await listMyAppointments(s.userId);
  const upcoming = all.filter((a: any) => ['scheduled', 'pending_approval'].includes(a.status) && new Date(a.starts_at) > new Date()).reverse();
  return (
    <>
      <h1>Olá, {s.user.full_name.split(' ')[0]}</h1>
      <nav aria-label="Minha área" className="row" style={{ marginBottom: '1rem' }}>
        <Link className="btn secondary" href="/app/agendamentos">Agendamentos</Link><Link className="btn secondary" href="/app/perfil">Perfil</Link>
        <Link className="btn secondary" href="/app/preferencias">Preferências</Link><Link className="btn secondary" href="/app/privacidade">Privacidade</Link>
        <Link className="btn secondary" href="/app/suporte">Suporte</Link>
      </nav>
      <h2>Próximos agendamentos</h2>
      {upcoming.length === 0 ? (
        <div className="empty"><p>Você não tem agendamentos futuros.</p><Link className="btn" href="/buscar">Buscar médicos</Link></div>
      ) : upcoming.map((a: any) => (
        <article className="card" key={a.id}>
          <h3 style={{ margin: 0 }}><Link href={`/app/agendamentos/${a.id}`}>{a.snapshot.practitioner.displayName}</Link></h3>
          <p>{new Date(a.starts_at).toLocaleString("pt-BR", { timeZone: a.timezone, dateStyle: "full", timeStyle: "short" })} — {a.snapshot.service}</p>
          <p className="small">{a.snapshot.location.address}</p>
          <span className={'badge ' + (a.status === 'pending_approval' ? 'warn' : 'ok')}>{a.status === 'pending_approval' ? 'Aguardando autorização' : a.attendance === 'confirmed' ? 'Presença confirmada' : 'Agendado'}</span>
          {a.needs_followup && <p className="banner">A clínica precisa falar com você sobre este agendamento. Aguarde o contato ou fale com o suporte.</p>}
        </article>
      ))}
    </>
  );
}
