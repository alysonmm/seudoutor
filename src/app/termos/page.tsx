import LegalPage from '@/components/LegalPage';
export const metadata = { title: 'Termos de Uso' };
export const dynamic = 'force-dynamic';
export default function Page() { return <LegalPage docKey="termos-paciente" />; }
