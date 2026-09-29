import { shell } from '@/components/PainelShell';
import JsonForm from '@/components/JsonForm';
import { listMembers } from '@/server/modules/orgs';
import { query } from '@/server/db';

export const metadata = { title: 'Equipe' };

export default async function Equipe({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel/equipe');
  const members = await listMembers(session.userId, org.id).catch(() => null);
  const [pracs, locs] = await Promise.all([
    query<any>(`SELECT p.id, COALESCE(p.display_name,'Profissional') name FROM practitioners p JOIN practitioner_memberships pm ON pm.practitioner_id=p.id WHERE pm.organization_id=$1`, [org.id]),
    query<any>('SELECT id, name FROM locations WHERE organization_id=$1', [org.id]),
  ]);
  return (
    <>
      <h1>Equipe</h1>{nav}
      {members === null ? <div className="banner">Somente gestores gerenciam a equipe.</div> : (<>
        <div className="table-wrap"><table><thead><tr><th scope="col">Nome</th><th scope="col">E-mail</th><th scope="col">Papel</th><th scope="col">Situação</th><th scope="col">Ação</th></tr></thead>
          <tbody>{members.map((m: any) => <tr key={m.membership_id}><td>{m.full_name}</td><td>{m.email}</td><td>{m.role_id}</td><td>{m.status === 'active' ? 'Ativo' : 'Removido'}</td>
            <td>{m.status === 'active' && <JsonForm action={`/api/v1/organizations/${org.id}/members/${m.membership_id}`} method="DELETE" fields={[]} submitLabel="Remover" secondary confirmText="Remover este membro? O acesso é revogado imediatamente." />}</td></tr>)}</tbody></table></div>
        <section className="card"><h2>Convidar</h2>
          <p className="small">O convite expira em 7 dias e só é aceito pela conta com este e-mail verificado. Secretárias precisam de médicos/unidades atribuídos (sem atribuição, não veem nada). Papéis profissionais exigem segundo fator.</p>
          <JsonForm action={`/api/v1/organizations/${org.id}/invitations`} submitLabel="Enviar convite" successMessage="Convite enviado por e-mail."
            fields={[{ name: 'email', label: 'E-mail', type: 'email', required: true },
              { name: 'role', label: 'Papel', type: 'select', required: true, options: [{ value: 'secretary', label: 'Secretária' }, { value: 'finance', label: 'Financeiro' }, { value: 'practitioner', label: 'Médico' }, { value: 'clinic_manager', label: 'Gestor' }] },
              { name: 'practitionerIds.0', label: 'Médicos atribuídos (secretária)', type: 'select', options: pracs.map((p: any) => ({ value: p.id, label: p.name })) },
              { name: 'locationIds.0', label: 'Unidade atribuída (secretária)', type: 'select', options: locs.map((l: any) => ({ value: l.id, label: l.name })) }]} /></section></>)}
    </>
  );
}
