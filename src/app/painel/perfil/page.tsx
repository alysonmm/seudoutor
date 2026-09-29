import { shell } from '@/components/PainelShell';
import JsonForm from '@/components/JsonForm';
import { query, one } from '@/server/db';
import { authorizeOrg } from '@/server/modules/authz';
import { listSpecialties } from '@/server/modules/catalog';

export const metadata = { title: 'Perfil profissional' };
const stLabel: Record<string, string> = { draft: 'Rascunho', pending_review: 'Em revisão', needs_changes: 'Precisa de ajustes', approved: 'Aprovado', suspended: 'Suspenso', rejected: 'Rejeitado' };

export default async function PerfilPro({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { session, org, nav } = await shell(searchParams, '/painel/perfil');
  const g = await authorizeOrg(session.userId, org.id, 'profile.manage').catch(() => null);
  if (!g) return (<><h1>Perfil profissional</h1>{nav}<div className="banner">Somente o médico gerencia o próprio perfil e envio ao credenciamento.</div></>);
  const p = await one<any>(`SELECT p.* FROM practitioners p WHERE p.user_id=$1`, [session.userId]);
  const regs = p ? await query<any>('SELECT uf, number FROM professional_registrations WHERE practitioner_id=$1', [p.id]) : [];
  const specs = p ? await query<any>('SELECT specialty_id, rqe FROM practitioner_specialties WHERE practitioner_id=$1', [p.id]) : [];
  const versions = p ? await query<any>('SELECT version, status, review_notes, submitted_at FROM public_profile_versions WHERE practitioner_id=$1 ORDER BY version DESC LIMIT 5', [p.id]) : [];
  const all = await listSpecialties();
  if (!p) return (<><h1>Perfil profissional</h1>{nav}<div className="empty">Sua conta não tem identidade profissional nesta organização.</div></>);
  return (
    <>
      <h1>Perfil profissional</h1>{nav}
      <p>Situação: <span className="badge">{stLabel[p.status]}</span> {p.status_reason && <span className="small">— {p.status_reason}</span>}</p>
      <p className="banner info">Alterar nome, CRM, RQE ou especialidade cria uma nova versão que só substitui a publicada depois de nova verificação. Não informamos como “especialista” quem não tem RQE correspondente.</p>
      <section className="card"><h2>Identidade (passa por revisão)</h2>
        <JsonForm action={`/api/v1/organizations/${org.id}/practitioners/${p.id}/identity`} method="PUT" submitLabel="Salvar rascunho" successMessage="Rascunho salvo. Envie para revisão abaixo."
          fields={[
            { name: 'displayName', label: 'Nome profissional', required: true, defaultValue: p.display_name ?? '' },
            { name: 'registrations.0.uf', label: 'UF do CRM', required: true, maxLength: 2, defaultValue: regs[0]?.uf ?? '' },
            { name: 'registrations.0.number', label: 'Número do CRM', required: true, inputMode: 'numeric', defaultValue: regs[0]?.number ?? '' },
            { name: 'specialties.0.specialtyId', label: 'Especialidade', type: 'select', required: true, defaultValue: specs[0]?.specialty_id ?? '', options: all.map((s: any) => ({ value: s.id, label: s.name })) },
            { name: 'specialties.0.rqe', label: 'RQE (se houver)', inputMode: 'numeric', defaultValue: specs[0]?.rqe ?? '' },
          ]} />
        <JsonForm action={`/api/v1/organizations/${org.id}/practitioners/${p.id}/submit`} fields={[]} submitLabel="Enviar para revisão" successMessage="Enviado ao credenciamento." /></section>
      <section className="card"><h2>Informações públicas (sem nova análise)</h2>
        <JsonForm action={`/api/v1/organizations/${org.id}/practitioners/${p.id}/public`} method="PATCH" submitLabel="Salvar"
          fields={[
            { name: 'bio', label: 'Apresentação objetiva', type: 'textarea', defaultValue: p.bio ?? '', maxLength: 1500, help: 'Sem promessa de cura, resultado ou comparação com outros profissionais. Texto puro.' },
            { name: 'languages', label: 'Idiomas (separados por vírgula)', type: 'list', defaultValue: (p.languages ?? []).join(', ') },
            { name: 'ageMin', label: 'Idade mínima atendida', type: 'number', defaultValue: p.age_min ?? '' }, { name: 'ageMax', label: 'Idade máxima atendida', type: 'number', defaultValue: p.age_max ?? '' },
            { name: 'travelBufferMinutes', label: 'Deslocamento entre locais (min)', type: 'number', defaultValue: p.travel_buffer_minutes },
          ]} /></section>
      <h2>Versões enviadas</h2>
      {versions.length === 0 ? <div className="empty">Nenhuma versão enviada.</div> : <ul>{versions.map((v: any) => <li key={v.version}>v{v.version} — {v.status} ({new Date(v.submitted_at).toLocaleDateString('pt-BR')}){v.review_notes ? ` — ${v.review_notes}` : ''}</li>)}</ul>}
    </>
  );
}
