import { requireUser } from '@/server/page-session';
import JsonForm from '@/components/JsonForm';
import Link from 'next/link';

export const metadata = { title: 'Cadastrar consultório ou clínica' };

export default async function Novo() {
  await requireUser('/painel/novo');
  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Cadastrar consultório ou clínica</h1>
      <p className="banner info">Contas profissionais exigem segundo fator de autenticação. Depois deste passo, cadastre identidade profissional (CRM), local, serviço e horários; o perfil só é publicado após verificação manual e teste/assinatura vigente.</p>
      <div className="card"><JsonForm action="/api/v1/organizations" submitLabel="Criar organização" redirectTo="/entrar?etapa=mfa&next=/painel" refresh={false}
        fields={[
          { name: 'kind', label: 'Tipo', type: 'select', required: true, options: [{ value: 'individual', label: 'Consultório individual' }, { value: 'clinic', label: 'Clínica' }] },
          { name: 'name', label: 'Nome do consultório/clínica', required: true },
          { name: 'asPractitioner', label: 'Sou médico(a) e atenderei nesta organização', type: 'checkbox' },
          { name: 'acceptContract', label: 'Li e aceito o Contrato de Prestação de Software (minuta em revisão jurídica).', type: 'checkbox' },
        ]} /></div>
      <p className="small"><Link href="/termos">Contratos e termos</Link></p>
    </div>
  );
}
