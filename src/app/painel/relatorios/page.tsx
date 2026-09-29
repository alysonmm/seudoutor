import { DateTime } from 'luxon';
import { shell } from '@/components/PainelShell';
import JsonForm from '@/components/JsonForm';
import { orgMetrics } from '@/server/modules/reports';
import { feedbackSummary } from '@/server/modules/quality';
import { authorizeOrg } from '@/server/modules/authz';
import { query } from '@/server/db';

export const metadata = { title: 'Relatórios' };
const pct = (v: number | null) => (v == null ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%');

export default async function Relatorios({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav, sp } = await shell(searchParams, '/painel/relatorios');
  const to = sp.ate ?? DateTime.now().toISODate()!, from = sp.de ?? DateTime.now().minus({ days: 30 }).toISODate()!;
  const m = await orgMetrics(session.userId, org.id, from, to).catch(() => null);
  const fb = await feedbackSummary(session.userId, org.id).catch(() => null);
  const canExport = await authorizeOrg(session.userId, org.id, 'export.general').then(() => true).catch(() => false);
  const exports = canExport ? await query<any>('SELECT id, status, created_at, expires_at, row_count FROM data_exports WHERE organization_id=$1 AND requested_by=$2 ORDER BY created_at DESC LIMIT 10', [org.id, session.userId]) : [];
  return (
    <>
      <h1>Relatórios</h1>{nav}
      <form method="get" className="row"><input type="hidden" name="org" value={org.id} />
        <label htmlFor="de">De</label><input id="de" name="de" type="date" defaultValue={from} style={{ width: 'auto' }} />
        <label htmlFor="ate">Até</label><input id="ate" name="ate" type="date" defaultValue={to} style={{ width: 'auto' }} /><button type="submit" className="secondary">Aplicar</button></form>
      {!m ? <div className="banner">Sem permissão para relatórios.</div> : (
        <section className="card"><h2>Indicadores</h2><p className="small muted">Período {m.period.from} a {m.period.to} • fuso {m.period.timezone}</p>
          <ul>
            <li>Ocupação = minutos agendados ÷ minutos disponibilizados (descontados bloqueios): <strong>{pct(m.occupancy)}</strong> ({m.bookedMinutes} de {m.availableMinutes} min)</li>
            <li>Falta = faltas ÷ (concluídas + faltas), sem consultas futuras: <strong>{pct(m.noShowRate)}</strong> ({m.noShow} de {m.completed + m.noShow})</li>
            <li>Novos pacientes (primeira consulta concluída na organização): <strong>{m.newPatients}</strong></li>
            <li>Cancelados: {m.cancelled} • Ativos: {m.scheduled} • Presença confirmada: {m.confirmed}</li>
          </ul></section>)}
      <section className="card"><h2>Feedback privado (agregado)</h2>
        {fb?.suppressed ? <p className="muted">{fb.note}</p> : fb ? <p>Pontualidade {fb.punctuality} • Comunicação {fb.communication} • Estrutura {fb.structure} ({fb.count} respostas). Comentários não são exibidos.</p> : <p className="muted">Sem permissão.</p>}</section>
      {canExport && (
        <section className="card"><h2>Exportar agendamentos (CSV)</h2>
          <p className="small">Gerada em segundo plano, arquivo privado válido por 24 horas, registrada em auditoria. Seu acesso é revalidado na geração.</p>
          <JsonForm action={`/api/v1/organizations/${org.id}/exports`} submitLabel="Solicitar exportação" fixed={{}}
            fields={[{ name: 'from', label: 'De', type: 'datetime-local', required: true }, { name: 'to', label: 'Até', type: 'datetime-local', required: true }]} />
          <ul>{exports.map((e: any) => <li key={e.id}>{new Date(e.created_at).toLocaleString('pt-BR')} — {e.status} {e.status === 'ready' && <a href={`/api/v1/organizations/${org.id}/exports/${e.id}`}>Baixar ({e.row_count} linhas)</a>}</li>)}</ul></section>)}
    </>
  );
}
