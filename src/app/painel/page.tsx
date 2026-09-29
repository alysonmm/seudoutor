import { DateTime } from 'luxon';
import { shell } from '@/components/PainelShell';
import { listOrgAppointments } from '@/server/modules/booking';
import { orgMetrics } from '@/server/modules/reports';
import { getSubscription } from '@/server/modules/billing';
import { authorizeOrg } from '@/server/modules/authz';
import Link from 'next/link';

export const metadata = { title: 'Painel' };
const pct = (v: number | null) => (v == null ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%');

export default async function Painel({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel');
  const tz = 'America/Sao_Paulo';
  const today = DateTime.now().setZone(tz);
  const [appts, metrics, sub] = await Promise.all([
    listOrgAppointments(session.userId, org.id, today.startOf('day').toISO()!, today.endOf('day').toISO()!).catch(() => []),
    orgMetrics(session.userId, org.id, today.minus({ days: 30 }).toISODate()!, today.toISODate()!).catch(() => null),
    getSubscription(session.userId, org.id).catch(() => null),
  ]);
  const canBill = await authorizeOrg(session.userId, org.id, 'billing.read').then(() => true).catch(() => false);
  const s = sub?.subscription;
  return (
    <>
      <h1>Painel</h1>{nav}
      {canBill && (!s || !['active', 'trialing', 'grace_period', 'cancel_at_period_end'].includes(s.status)) && (
        <div className="banner"><strong>Seu perfil não está publicado para novas marcações</strong> — sem teste ou assinatura vigente. <Link href={`/painel/assinatura?org=${org.id}`}>Iniciar teste gratuito ou contratar</Link>.</div>
      )}
      {s?.status === 'grace_period' && <div className="banner">Pagamento em atraso: você está na carência até {new Date(s.grace_ends_at).toLocaleDateString('pt-BR')}.</div>}
      <section aria-labelledby="hoje"><h2 id="hoje">Hoje ({today.toFormat('dd/LL/yyyy')})</h2>
        {appts.length === 0 ? <div className="empty">Nenhum compromisso hoje.</div> : (
          <div className="table-wrap"><table><thead><tr><th scope="col">Hora</th><th scope="col">Paciente</th><th scope="col">Serviço</th><th scope="col">Situação</th></tr></thead>
            <tbody>{appts.map((a: any) => <tr key={a.id}><td>{new Date(a.starts_at).toLocaleTimeString('pt-BR', { timeZone: a.timezone, hour: '2-digit', minute: '2-digit' })}</td><td>{a.patient_name}</td><td>{a.service}</td><td>{a.status}/{a.attendance}</td></tr>)}</tbody></table></div>
        )}</section>
      {metrics ? (
        <section aria-labelledby="ind"><h2 id="ind">Últimos 30 dias</h2>
          <p className="small muted">Período {metrics.period.from} a {metrics.period.to} • fuso {metrics.period.timezone}</p>
          <div className="grid cols-3">
            <div className="card"><div className="small muted">Agendados (ativos)</div><strong style={{ fontSize: '1.6rem' }}>{metrics.scheduled}</strong></div>
            <div className="card"><div className="small muted">Confirmaram presença</div><strong style={{ fontSize: '1.6rem' }}>{metrics.confirmed}</strong></div>
            <div className="card"><div className="small muted">Cancelados</div><strong style={{ fontSize: '1.6rem' }}>{metrics.cancelled}</strong></div>
            <div className="card"><div className="small muted">Taxa de falta</div><strong style={{ fontSize: '1.6rem' }}>{pct(metrics.noShowRate)}</strong></div>
            <div className="card"><div className="small muted">Ocupação</div><strong style={{ fontSize: '1.6rem' }}>{pct(metrics.occupancy)}</strong></div>
            <div className="card"><div className="small muted">Novos pacientes</div><strong style={{ fontSize: '1.6rem' }}>{metrics.newPatients}</strong></div>
          </div></section>
      ) : <div className="empty">Indicadores indisponíveis para o seu papel.</div>}
    </>
  );
}
