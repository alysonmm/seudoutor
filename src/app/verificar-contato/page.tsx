import type { Metadata } from 'next';
import JsonForm from '@/components/JsonForm';

export const metadata: Metadata = { title: 'Verificar contato' };

export default async function Verificar({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <div style={{ maxWidth: 440 }}>
      <h1>Confirme seu e-mail</h1>
      <p>Enviamos um código de 6 dígitos (válido por 15 minutos). Se o e-mail já tinha cadastro, você recebeu um aviso no lugar do código.</p>
      <div className="card">
        <JsonForm action="/api/v1/auth/verify-email" submitLabel="Confirmar" redirectTo={sp.tipo === 'profissional' ? '/entrar?next=/painel/novo' : '/entrar'} refresh={false}
          fields={[{ name: 'email', label: 'E-mail', type: 'email', required: true }, { name: 'code', label: 'Código', required: true, inputMode: 'numeric', maxLength: 6 }]} />
      </div>
    </div>
  );
}
