import Link from 'next/link';
import { requireOrgContext } from '@/server/page-session';

const items = [
  ['/painel', 'Início'], ['/painel/agenda', 'Agenda'], ['/painel/pacientes', 'Pacientes'], ['/painel/perfil', 'Perfil'], ['/painel/locais', 'Locais'],
  ['/painel/servicos', 'Serviços e horários'], ['/painel/convenios', 'Convênios'], ['/painel/equipe', 'Equipe'], ['/painel/relatorios', 'Relatórios'], ['/painel/assinatura', 'Assinatura'],
];

/** Carrega o contexto autorizado no servidor e desenha a navegação. O org vem da URL, mas só vale se houver vínculo ativo. */
export async function shell(searchParams: Promise<Record<string, string | undefined>>, path: string) {
  const sp = await searchParams;
  const ctx = await requireOrgContext(sp.org, path);
  const nav = (
    <>
      <div className="row"><strong>{ctx.org.name}</strong><span className="badge">{ctx.org.roles.join(', ')}</span>
        {ctx.orgs.length > 1 && <form method="get" className="row"><label htmlFor="org" className="sr-only">Organização</label>
          <select id="org" name="org" defaultValue={ctx.org.id}>{ctx.orgs.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select><button type="submit" className="secondary">Trocar</button></form>}</div>
      <nav aria-label="Painel" className="row" style={{ margin: '.75rem 0 1rem' }}>
        {items.map(([href, label]) => <Link key={href} href={`${href}?org=${ctx.org.id}`} aria-current={href === path ? 'page' : undefined} className={href === path ? 'btn' : 'btn secondary'}>{label}</Link>)}
      </nav>
    </>
  );
  return { ...ctx, nav, sp };
}
