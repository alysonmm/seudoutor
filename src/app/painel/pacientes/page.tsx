import { shell } from '@/components/PainelShell';
import { authorizeOrg } from '@/server/modules/authz';
import { query } from '@/server/db';

export const metadata = { title: 'Pacientes' };

export default async function Pacientes({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel/pacientes');
  const g = await authorizeOrg(session.userId, org.id, 'patient.read_admin').catch(() => null);
  // apenas pacientes com consulta em médicos/locais do escopo do usuário (vínculo ao atendimento)
  const p: unknown[] = [org.id];
  const rows = g ? await query<any>(
    `SELECT op.id, op.full_name, op.phone, op.created_via, count(a.id)::int appts, max(a.starts_at) last_at,
            EXISTS (SELECT 1 FROM patient_account_links l WHERE l.organization_patient_id = op.id) linked
       FROM organization_patients op JOIN appointments a ON a.organization_patient_id = op.id
      WHERE op.organization_id=$1 AND ${g.sql('a', p)} GROUP BY op.id ORDER BY max(a.starts_at) DESC LIMIT 200`, p) : null;
  return (
    <>
      <h1>Pacientes</h1>{nav}
      <p className="small">Dados administrativos apenas. Não registre informações clínicas aqui.</p>
      {rows === null ? <div className="banner">Sem permissão.</div> : rows.length === 0 ? <div className="empty">Nenhum paciente ainda.</div> : (
        <div className="table-wrap"><table><thead><tr><th scope="col">Nome</th><th scope="col">Contato</th><th scope="col">Origem</th><th scope="col">Consultas</th><th scope="col">Última</th><th scope="col">Conta vinculada</th></tr></thead>
          <tbody>{rows.map((r: any) => <tr key={r.id}><td>{r.full_name}</td><td>{r.phone ?? '—'}</td><td>{r.created_via === 'app' ? 'Aplicativo' : 'Recepção'}</td><td>{r.appts}</td><td>{new Date(r.last_at).toLocaleDateString('pt-BR')}</td><td>{r.linked ? 'Sim (verificada)' : 'Não'}</td></tr>)}</tbody></table></div>
      )}
    </>
  );
}
