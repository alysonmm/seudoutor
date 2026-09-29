import type { Metadata } from 'next';
import LoginFlow from '@/components/LoginFlow';

export const metadata: Metadata = { title: 'Entrar' };

export default async function Entrar({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : '/app'; // evita redirecionamento aberto
  return (
    <div style={{ maxWidth: 440 }}>
      <h1>Entrar</h1>
      <div className="card"><LoginFlow next={next} startAtMfa={sp.etapa === 'mfa'} /></div>
    </div>
  );
}
