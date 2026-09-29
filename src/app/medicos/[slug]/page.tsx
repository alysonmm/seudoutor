import { notFound } from 'next/navigation';
import Link from 'next/link';
import { DateTime } from 'luxon';
import { publicProfile, publicAvailability } from '@/server/modules/search';
import { pageSession } from '@/server/page-session';
import BookingFlow from '@/components/BookingFlow';

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const p = await publicProfile((await params).slug);
  return { title: p ? p.displayName : 'Perfil não encontrado' };
}

export default async function Perfil({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params; const sp = await searchParams;
  const p = await publicProfile(slug);
  if (!p) notFound();
  const session = await pageSession();
  const locations = [...new Map(p.offerings.map((o) => [o.location.id, o.location])).values()];
  const locId = sp.local && locations.some((l) => l.id === sp.local) ? sp.local : locations[0]?.id;
  const offerings = p.offerings.filter((o) => o.location.id === locId);
  const offering = offerings.find((o) => o.offeringId === sp.servico) ?? offerings[0];
  let slots: { startsAt: string; localDate: string; localTime: string }[] = [];
  let tz = 'America/Sao_Paulo';
  if (offering) {
    const from = DateTime.now().toISODate()!, to = DateTime.now().plus({ days: 30 }).toISODate()!;
    const av = await publicAvailability(offering.offeringId, from, to);
    slots = av?.slots ?? []; tz = av?.timezone ?? tz;
  }
  const byDate = new Map<string, typeof slots>();
  type Sl = (typeof slots)[number];
  for (const s of slots as Sl[]) byDate.set(s.localDate, [...(byDate.get(s.localDate) ?? []), s]);
  return (
    <>
      <h1>{p.displayName}</h1>
      <p>{p.specialties.map((s) => s.name + (s.rqe ? ` (RQE ${s.rqe})` : '')).join(' • ')}</p>
      {p.verification && <p className="small muted">{p.verification}. Verificação manual do registro; não representa endosso do CFM nem certificação de qualidade clínica.</p>}
      {p.bio && <p style={{ whiteSpace: 'pre-wrap' }}>{p.bio}</p>}
      {p.languages.length > 0 && <p className="small">Idiomas: {p.languages.join(', ')}</p>}
      {p.ageRange && <p className="small">Público atendido: {p.ageRange.min ?? 0} a {p.ageRange.max ?? '—'} anos</p>}

      {!offering ? (
        <div className="empty">Este profissional não possui serviços disponíveis para marcação no momento.</div>
      ) : (
        <>
          <section className="card" aria-labelledby="loc">
            <h2 id="loc">Local e serviço</h2>
            <form method="get" className="grid cols-2">
              <div><label htmlFor="local">Local</label>
                <select id="local" name="local" defaultValue={locId}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.address}</option>)}</select></div>
              <div><label htmlFor="servico">Serviço</label>
                <select id="servico" name="servico" defaultValue={offering.offeringId}>{offerings.map((o) => <option key={o.offeringId} value={o.offeringId}>{o.service} ({o.durationMinutes} min)</option>)}</select></div>
              <div><button type="submit" className="secondary">Atualizar preço e horários</button></div>
            </form>
            <p><strong>Endereço:</strong> {offering.location.address}</p>
            {offering.location.arrivalInstructions && <p className="small">Como chegar: {offering.location.arrivalInstructions}</p>}
            {offering.location.accessibility.length > 0 && <p className="small">Acessibilidade: {offering.location.accessibility.join(', ')}</p>}
            <p><strong>Particular:</strong> {!offering.acceptsPrivate ? 'não atende particular neste serviço' : offering.priceInformed ? brl(offering.priceCents!) : 'valor não informado pelo profissional'}
              {offering.paymentMethods.length > 0 && <> — pagamento no local: {offering.paymentMethods.join(', ')}</>}</p>
            {offering.conditions && <p className="small">Condições: {offering.conditions}</p>}
            {offering.returnPolicy && <p className="small">Retorno (informado pelo profissional): {offering.returnPolicy}</p>}
            {offering.insurance.length > 0 && (
              <div><strong>Convênios aceitos neste local e serviço:</strong>
                <ul>{offering.insurance.map((i: any) => <li key={i.insurer + i.product}>{i.insurer} — {i.product}{i.requiresAuthorization ? ' (exige autorização; sua solicitação ficará pendente até a resposta)' : ''} <span className="small muted">atualizado em {new Date(i.updatedAt).toLocaleDateString('pt-BR')}</span></li>)}</ul>
                <p className="small muted">Aceitar a operadora não garante cobertura do seu produto/plano.</p></div>
            )}
          </section>

          <section className="card" aria-labelledby="hor">
            <h2 id="hor">Horários disponíveis</h2>
            {byDate.size === 0 ? (
              <div className="empty">Não há horários abertos nos próximos 30 dias neste local. Volte mais tarde ou escolha outro local/serviço.</div>
            ) : (
              <BookingFlow
                loggedIn={!!session} loginHref={`/entrar?next=${encodeURIComponent(`/medicos/${slug}?local=${locId}&servico=${offering.offeringId}`)}`}
                offering={{ id: offering.offeringId, service: offering.service, priceCents: offering.priceCents, priceInformed: offering.priceInformed, acceptsPrivate: offering.acceptsPrivate,
                  insurance: offering.insurance.map((i: any) => ({ id: i.productId ?? null, label: `${i.insurer} — ${i.product}` })), address: offering.location.address, timezone: tz }}
                days={[...byDate.entries()].map(([d, ss]) => ({ date: d, label: DateTime.fromISO(d).setLocale('pt-BR').toFormat("ccc dd/LL"), slots: ss.map((s: Sl) => ({ startsAt: s.startsAt, time: s.localTime })) }))}
              />
            )}
          </section>
        </>
      )}
      <p><Link href="/buscar">← Voltar à busca</Link></p>
    </>
  );
}
