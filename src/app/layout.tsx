import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { pageSession } from '@/server/page-session';
import { config } from '@/server/config';
import { query } from '@/server/db';
import LogoutButton from '@/components/LogoutButton';
import RegisterSW from '@/components/RegisterSW';

export const metadata: Metadata = {
  title: { default: 'Seu Doutor — busque e agende consultas', template: '%s • Seu Doutor' },
  description: 'Encontre médicos, compare informações e agende consultas presenciais. Gratuito para pacientes.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1263c9' };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const s = await pageSession().catch(() => null);
  let staff = false; let hasOrg = false;
  if (s && (!s.mfaRequired || s.mfaVerified)) {
    try {
      staff = (await query("SELECT 1 FROM platform_staff WHERE user_id=$1 AND status='active'", [s.userId])).length > 0;
      hasOrg = (await query("SELECT 1 FROM memberships WHERE user_id=$1 AND status='active'", [s.userId])).length > 0;
    } catch { /* menu simplificado */ }
  }
  return (
    <html lang="pt-BR">
      <body>
        <a className="skip-link" href="#conteudo">Ir para o conteúdo</a>
        {!config.isProd && (
          <div className="banner" role="note" style={{ margin: 0, borderRadius: 0 }}>
            Ambiente de desenvolvimento/homologação — dados sintéticos. Documentos legais são <strong>MINUTAS pendentes de revisão jurídica</strong>.
          </div>
        )}
        <header className="site">
          <div className="container bar">
            <Link href="/" aria-label="Seu Doutor — página inicial"><img src="/brand/06_logo_horizontal_fundo_branco.png" alt="Seu Doutor" width={139} height={40} /></Link>
            <nav className="main" aria-label="Principal">
              <Link href="/buscar">Buscar médicos</Link>
              <Link href="/planos">Para profissionais</Link>
              {s ? (
                <>
                  <Link href="/app">Minha área</Link>
                  {hasOrg && <Link href="/painel">Painel</Link>}
                  {staff && <Link href="/admin">Administração</Link>}
                  <LogoutButton />
                </>
              ) : (
                <>
                  <Link href="/entrar">Entrar</Link>
                  <Link href="/cadastro" className="btn">Criar conta</Link>
                </>
              )}
            </nav>
          </div>
        </header>
        <main id="conteudo" tabIndex={-1}><div className="container">{children}</div></main>
        <footer className="site">
          <div className="container">
            <nav aria-label="Institucional">
              <Link href="/termos">Termos</Link><Link href="/privacidade">Privacidade</Link><Link href="/cookies">Cookies</Link>
              <Link href="/cancelamentos">Cancelamentos</Link><Link href="/avaliacoes">Avaliações</Link>
              <Link href="/acessibilidade">Acessibilidade</Link><Link href="/ajuda">Ajuda</Link><Link href="/contato">Contato</Link>
            </nav>
            <p>Seu Doutor não é plano de saúde, seguro nem pronto atendimento. O atendimento é prestado pelo profissional ou clínica escolhidos. Em emergência, ligue 192 (SAMU).</p>
            <p>Operador: [RAZÃO SOCIAL / CNPJ — A PREENCHER]</p>
          </div>
        </footer>
        <RegisterSW />
      </body>
    </html>
  );
}
