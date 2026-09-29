import { adminShell } from '@/components/AdminShell';
import JsonForm from '@/components/JsonForm';
import { listOpenRequests } from '@/server/modules/privacy';

export const metadata = { title: 'Privacidade' };

export default async function Priv() {
  const { session, allowed, nav } = await adminShell('/admin/privacidade', 'privacy.manage');
  const rows: any[] = allowed ? await listOpenRequests(session.userId) : [];
  return (<><h1>Solicitações de titulares</h1>{nav}
    <p className="banner info">Prazos por tipo de direito são <strong>placeholders</strong> em configuração até o encarregado definir. Toda decisão exige fundamentação.</p>
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : rows.length === 0 ? <div className="empty">Nenhuma solicitação em aberto.</div> : rows.map((r) => (
      <section className="card" key={r.id}><h2>{r.protocol} — {r.kind}</h2><p>Prazo: {new Date(r.due_at).toLocaleDateString('pt-BR')} • {r.status}</p>
        <JsonForm action={'/api/v1/admin/privacy-requests/' + r.id + '/resolve'} submitLabel="Registrar decisão"
          fields={[{ name: 'status', label: 'Resultado', type: 'select', required: true, options: [{ value: 'fulfilled', label: 'Atendido' }, { value: 'partially_fulfilled', label: 'Atendido parcialmente (com retenção)' }, { value: 'denied', label: 'Negado' }] },
            { name: 'decision', label: 'Decisão fundamentada', type: 'textarea', required: true }, { name: 'retainedCategories', label: 'Categorias retidas (vírgula)', type: 'list' }, { name: 'responsible', label: 'Responsável' }]} />
        {r.kind === 'erasure' && <JsonForm action={'/api/v1/admin/privacy-requests/' + r.id + '/erase'} submitLabel="Executar eliminação com minimização" secondary confirmText="Executar eliminação? Não é reversível." fields={[]} />}
      </section>))}
  </>);
}
