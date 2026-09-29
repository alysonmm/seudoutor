import Link from 'next/link';
import type { Metadata } from 'next';
import { searchPractitioners } from '@/server/modules/search';
import { listInsurers, listSpecialties } from '@/server/modules/catalog';
import GeoButton from '@/components/GeoButton';

export const metadata: Metadata = { title: 'Buscar médicos' };
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default async function Buscar({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const clean = Object.fromEntries(Object.entries(sp).filter(([, v]) => v !== undefined && v !== ''));
  let result: Awaited<ReturnType<typeof searchPractitioners>> | null = null;
  let error: string | null = null;
  try { result = await searchPractitioners(clean as any); } catch { error = 'Filtros inválidos. Revise os campos e tente novamente.'; }
  const [specialties, insurers] = await Promise.all([listSpecialties(), listInsurers()]);
  const fmt = (iso: string, tz = 'America/Sao_Paulo') => new Date(iso).toLocaleString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return (
    <>
      <h1>Buscar médicos</h1>
      <form method="get" className="card" aria-label="Filtros de busca">
        <div className="grid cols-3">
          <div><label htmlFor="q">Nome ou serviço</label><input id="q" name="q" defaultValue={sp.q} /></div>
          <div><label htmlFor="specialty">Especialidade</label>
            <select id="specialty" name="specialty" defaultValue={sp.specialty ?? ''}><option value="">Todas</option>{specialties.map((s: any) => <option key={s.id} value={s.slug}>{s.name}</option>)}</select></div>
          <div><label htmlFor="city">Cidade</label><input id="city" name="city" defaultValue={sp.city} /></div>
          <div><label htmlFor="neighborhood">Bairro</label><input id="neighborhood" name="neighborhood" defaultValue={sp.neighborhood} /></div>
          <div><label htmlFor="insuranceProductId">Convênio / produto</label>
            <select id="insuranceProductId" name="insuranceProductId" defaultValue={sp.insuranceProductId ?? ''}><option value="">Qualquer</option>
              {insurers.map((i: any) => <optgroup key={i.id} label={i.name}>{i.products.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}</select>
            <div className="help">“Aceita operadora” não garante cobertura do seu produto. Confirme com sua operadora.</div></div>
          <div><label htmlFor="maxPriceCents">Valor máximo (centavos)</label><input id="maxPriceCents" name="maxPriceCents" inputMode="numeric" defaultValue={sp.maxPriceCents} /></div>
          <div><label htmlFor="date">Data</label><input id="date" name="date" type="date" defaultValue={sp.date} /></div>
          <div><label htmlFor="timeFrom">Horário a partir de</label><input id="timeFrom" name="timeFrom" type="time" defaultValue={sp.timeFrom} /></div>
          <div><label htmlFor="patientAge">Idade do paciente</label><input id="patientAge" name="patientAge" inputMode="numeric" defaultValue={sp.patientAge} /></div>
          <div><label htmlFor="accessibility">Acessibilidade</label><input id="accessibility" name="accessibility" defaultValue={sp.accessibility} placeholder="ex.: rampa" /></div>
          <div><label htmlFor="language">Idioma</label><input id="language" name="language" defaultValue={sp.language} /></div>
          <div><label htmlFor="sort">Ordenar por</label>
            <select id="sort" name="sort" defaultValue={sp.sort ?? 'next_slot'}>
              <option value="next_slot">Próximo horário</option><option value="distance">Proximidade</option><option value="price">Preço</option></select>
            <div className="help">Nunca ordenamos por plano contratado pelo médico.</div></div>
        </div>
        <input type="hidden" name="lat" defaultValue={sp.lat} /><input type="hidden" name="lng" defaultValue={sp.lng} />
        <div className="row" style={{ marginTop: '1rem' }}>
          <button type="submit">Buscar</button>
          <GeoButton />
        </div>
        <p className="help">Localização é opcional e usada apenas nesta busca para calcular a distância em linha reta (aproximada). Você pode informar cidade ou bairro manualmente.</p>
      </form>

      {error && <p role="alert" className="field-error">{error}</p>}
      {result && (
        <section aria-live="polite" aria-label="Resultados">
          <p>{result.total} {result.total === 1 ? 'resultado' : 'resultados'}</p>
          {result.items.length === 0 && (
            <div className="empty"><p>Nenhum médico encontrado com estes filtros.</p><p>Tente ampliar a cidade, remover a data ou outro convênio.</p></div>
          )}
          {result.items.map((i) => (
            <article key={i.practitionerId + i.locationId} className="card result">
              <h2 style={{ margin: 0 }}><Link href={`/medicos/${i.slug}?local=${i.locationId}`}>{i.displayName}</Link></h2>
              <div>{i.specialties.map((s) => s.name + (s.rqe ? ` (RQE ${s.rqe})` : '')).join(' • ')}</div>
              <div className="small muted">{i.verification}</div>
              <div>{i.neighborhood}, {i.city}/{i.uf}{i.distanceKm != null && <> — cerca de {i.distanceKm} km <span className="small muted">(linha reta, aproximado)</span></>}</div>
              <div>{i.priceKnown ? <>A partir de <strong>{brl(i.minPriceCents!)}</strong> (particular)</> : <span className="muted">Valor não informado pelo profissional</span>}</div>
              <div>{i.nextSlot ? <>Próximo horário: <strong>{fmt(i.nextSlot.startsAt)}</strong></> : <span className="muted">Sem horários nos próximos 14 dias. Veja o perfil para outras datas.</span>}</div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
