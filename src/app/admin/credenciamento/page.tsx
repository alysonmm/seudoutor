import { adminShell } from '@/components/AdminShell';
import JsonForm from '@/components/JsonForm';
import { listReviewQueue } from '@/server/modules/credentialing';

export const metadata = { title: 'Credenciamento' };

export default async function Cred() {
  const { session, allowed, nav } = await adminShell('/admin/credenciamento', 'credential.review');
  const q: any[] = allowed ? await listReviewQueue(session.userId) : [];
  return (<><h1>Credenciamento</h1>{nav}
    <p className="banner info">Verificação <strong>manual</strong>: consulte a fonte oficial e registre fonte, data, inscrição, situação e próxima revisão. Nenhuma verificação online é simulada.</p>
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : q.length === 0 ? <div className="empty">Fila vazia.</div> : q.map((v) => (
      <section className="card" key={v.version_id}>
        <h2>{v.data.display_name} <span className="badge">v{v.version}</span></h2>
        <p>CRM: {v.data.registrations.map((r: any) => r.council + '/' + r.uf + ' ' + r.number).join(', ')}</p>
        <p>Especialidades: {v.data.specialties.map((s: any) => s.name + (s.rqe ? ' (RQE ' + s.rqe + ')' : '')).join(', ')}</p>
        <p className="small">{v.has_published ? 'Já publicado: a versão atual segue no ar até esta ser aprovada.' : 'Ainda não publicado.'}</p>
        <JsonForm action={'/api/v1/admin/credentialing/' + v.version_id + '/review'} submitLabel="Registrar decisão" successMessage="Decisão registrada."
          fields={[
            { name: 'decision', label: 'Decisão', type: 'select', required: true, options: [{ value: 'approve', label: 'Aprovar' }, { value: 'needs_changes', label: 'Pedir ajustes' }, { value: 'reject', label: 'Rejeitar' }] },
            { name: 'notes', label: 'Observações (visíveis ao profissional)', type: 'textarea' },
            { name: 'evidence.source', label: 'Fonte da verificação (aprovação)' }, { name: 'evidence.registration', label: 'Inscrição verificada (ex.: CRM/SP 123456)' },
            { name: 'evidence.situation', label: 'Situação constatada' }, { name: 'evidence.checkedAt', label: 'Data da consulta', type: 'date' }, { name: 'evidence.nextReviewAt', label: 'Próxima revisão', type: 'date' },
          ]} /></section>))}
  </>);
}
