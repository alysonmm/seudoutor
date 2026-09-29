import { requireUser } from '@/server/page-session';
import JsonForm from '@/components/JsonForm';
import { one } from '@/server/db';

export const metadata = { title: 'Meu perfil' };

export default async function Perfil() {
  const s = await requireUser('/app/perfil');
  const u = await one<any>('SELECT full_name, phone, email FROM users WHERE id=$1', [s.userId]);
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>Meu perfil</h1>
      <p>E-mail: {u.email} (verificado)</p>
      <div className="card"><JsonForm action="/api/v1/me" method="PATCH" submitLabel="Salvar" successMessage="Dados atualizados."
        fields={[{ name: 'fullName', label: 'Nome completo', required: true, defaultValue: u.full_name }, { name: 'phone', label: 'Telefone', inputMode: 'tel', defaultValue: u.phone ?? '' }]} /></div>
    </div>
  );
}
