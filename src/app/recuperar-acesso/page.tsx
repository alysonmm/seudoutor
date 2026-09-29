import type { Metadata } from 'next';
import JsonForm from '@/components/JsonForm';

export const metadata: Metadata = { title: 'Recuperar acesso' };

export default function Recuperar() {
  return (
    <div style={{ maxWidth: 440 }}>
      <h1>Recuperar acesso</h1>
      <div className="card">
        <h2>1. Receber código</h2>
        <JsonForm action="/api/v1/auth/password-reset/request" submitLabel="Enviar código" successMessage="Se o e-mail existir, enviamos um código." refresh={false}
          fields={[{ name: 'email', label: 'E-mail', type: 'email', required: true }]} />
      </div>
      <div className="card">
        <h2>2. Definir nova senha</h2>
        <JsonForm action="/api/v1/auth/password-reset/confirm" submitLabel="Redefinir senha" redirectTo="/entrar" refresh={false}
          fields={[{ name: 'email', label: 'E-mail', type: 'email', required: true }, { name: 'code', label: 'Código', required: true, inputMode: 'numeric' },
            { name: 'newPassword', label: 'Nova senha', type: 'password', required: true, autoComplete: 'new-password' }]} />
        <p className="small muted">Quem usa segundo fator continuará precisando dele; a redefinição encerra as sessões abertas.</p>
      </div>
    </div>
  );
}
