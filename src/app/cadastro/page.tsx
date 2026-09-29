import type { Metadata } from 'next';
import Link from 'next/link';
import JsonForm from '@/components/JsonForm';

export const metadata: Metadata = { title: 'Criar conta' };

export default async function Cadastro({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const pro = sp.tipo === 'profissional';
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>{pro ? 'Criar conta profissional' : 'Criar conta de paciente'}</h1>
      <p className="muted">{pro ? 'Depois de confirmar seu e-mail, você cadastra o consultório ou a clínica.' : 'Gratuito. Para adultos, para uso próprio.'}</p>
      <div className="card">
        <JsonForm action="/api/v1/auth/register" submitLabel="Criar conta" redirectTo={`/verificar-contato?tipo=${pro ? 'profissional' : 'paciente'}`} refresh={false}
          fields={[
            { name: 'fullName', label: 'Nome completo', required: true, autoComplete: 'name' },
            { name: 'email', label: 'E-mail', type: 'email', required: true, autoComplete: 'email' },
            { name: 'phone', label: 'Telefone (opcional)', type: 'text', inputMode: 'tel', autoComplete: 'tel' },
            { name: 'password', label: 'Senha', type: 'password', required: true, autoComplete: 'new-password', help: 'Mínimo de 10 caracteres.' },
            { name: 'acceptTerms', label: 'Li e aceito os Termos de Uso e li o Aviso de Privacidade.', type: 'checkbox' },
          ]} />
        <p className="small">Leia: <Link href="/termos">Termos</Link> • <Link href="/privacidade">Aviso de Privacidade</Link>. Marketing é opcional e fica desativado até você escolher.</p>
      </div>
      <p>Já tem conta? <Link href="/entrar">Entrar</Link></p>
    </div>
  );
}
