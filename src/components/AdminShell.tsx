import Link from 'next/link';
import { requireStaff } from '@/server/page-session';
import { authorizeStaff } from '@/server/modules/staff';

const items = [['/admin', 'Início'], ['/admin/credenciamento', 'Credenciamento'], ['/admin/organizacoes', 'Organizações'], ['/admin/assinaturas', 'Assinaturas'], ['/admin/moderacao', 'Moderação'],
  ['/admin/suporte', 'Suporte'], ['/admin/privacidade', 'Privacidade'], ['/admin/incidentes', 'Incidentes'], ['/admin/auditoria', 'Auditoria'], ['/admin/documentos', 'Documentos'], ['/admin/configuracoes', 'Configurações']];

/** `perm`: permissão de plataforma exigida pela página (verificada no servidor). Sem ela, mostra aviso — nada é carregado. */
export async function adminShell(path: string, perm: string) {
  const { session, roles } = await requireStaff(path);
  const allowed = await authorizeStaff(session.userId, perm);
  const nav = (<>
    <div className="row"><strong>Administração</strong><span className="badge">{roles.join(', ')}</span></div>
    <nav aria-label="Administração" className="row" style={{ margin: '.75rem 0 1rem' }}>
      {items.map(([h, l]) => <Link key={h} href={h} className={h === path ? 'btn' : 'btn secondary'} aria-current={h === path ? 'page' : undefined}>{l}</Link>)}</nav>
  </>);
  return { session, roles, allowed, nav };
}
