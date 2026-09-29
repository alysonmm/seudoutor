import JsonForm from '@/components/JsonForm';
import Link from 'next/link';
import { pageSession } from '@/server/page-session';

export const metadata = { title: 'Convite' };

export default async function Convite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const s = await pageSession();
  return (
    <div style={{ maxWidth: 520 }}>
      <h1>Convite para participar de uma organização</h1>
      {!s ? (
        <p>Entre ou crie uma conta <strong>com o e-mail que recebeu o convite</strong> e volte a este link. <Link className="btn" href={`/entrar?next=${encodeURIComponent('/convites/' + token)}`}>Entrar</Link></p>
      ) : (
        <div className="card">
          <p>O convite só é aceito pela conta cujo e-mail verificado é o do destinatário.</p>
          <JsonForm action="/api/v1/invitations/accept" fixed={{ token }} fields={[]} submitLabel="Aceitar convite" redirectTo="/entrar?next=/painel" refresh={false}
            successMessage="Convite aceito. Como você terá acesso profissional, será pedido o segundo fator no próximo login." />
        </div>
      )}
    </div>
  );
}
