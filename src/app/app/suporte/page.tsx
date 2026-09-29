import { requireUser } from '@/server/page-session';
import JsonForm from '@/components/JsonForm';

export const metadata = { title: 'Suporte' };

export default async function Suporte() {
  await requireUser('/app/suporte');
  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Suporte</h1>
      <p className="banner info">Não envie diagnósticos, exames ou receitas. Em emergência, ligue 192 (SAMU). Você recebe um protocolo imediatamente.</p>
      <div className="card"><JsonForm action="/api/v1/me/tickets" submitLabel="Enviar" successMessage="Recebemos sua mensagem."
        fields={[{ name: 'subject', label: 'Assunto', required: true, maxLength: 150 }, { name: 'body', label: 'Mensagem', type: 'textarea', required: true, maxLength: 2000 }]} /></div>
    </div>
  );
}
