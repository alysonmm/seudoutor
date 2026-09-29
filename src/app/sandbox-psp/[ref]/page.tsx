import { notFound } from 'next/navigation';
import { config } from '@/server/config';
import JsonForm from '@/components/JsonForm';

export const metadata = { title: 'PSP sandbox (somente teste)' };

export default async function Sandbox({ params }: { params: Promise<{ ref: string }> }) {
  if (config.isProd) notFound();
  const { ref } = await params;
  return (<div style={{ maxWidth: 480 }}><h1>PSP sandbox</h1>
    <p className="banner">Simulador de desenvolvimento. Não é um provedor de pagamento real: nenhum valor é cobrado. A confirmação chega ao sistema por webhook assinado, como aconteceria com um PSP.</p>
    <JsonForm action="/api/v1/dev/sandbox-pay" fixed={{ ref, outcome: 'success' }} fields={[]} submitLabel="Simular pagamento aprovado" successMessage="Pagamento simulado. Volte ao painel → Assinatura." />
    <JsonForm action="/api/v1/dev/sandbox-pay" fixed={{ ref, outcome: 'failure' }} fields={[]} submitLabel="Simular falha de pagamento" secondary />
  </div>);
}
