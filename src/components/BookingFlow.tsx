'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface Props {
  loggedIn: boolean; loginHref: string;
  offering: { id: string; service: string; priceCents: number | null; priceInformed: boolean; acceptsPrivate: boolean; insurance: { id: string | null; label: string }[]; address: string; timezone: string };
  days: { date: string; label: string; slots: { startsAt: string; time: string }[] }[];
}
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Selecionar horário → reserva temporária (5 min) → revisar condições → confirmar (revalidação no servidor) → comprovante. */
export default function BookingFlow({ loggedIn, loginHref, offering, days }: Props) {
  const [step, setStep] = useState<'pick' | 'review' | 'done'>('pick');
  const [slot, setSlot] = useState<{ startsAt: string; label: string } | null>(null);
  const [hold, setHold] = useState<{ holdId: string; expiresAt: string } | null>(null);
  const [payer, setPayer] = useState<'private' | 'insurance'>(offering.acceptsPrivate ? 'private' : 'insurance');
  const [product, setProduct] = useState<string>(offering.insurance[0]?.id ?? '');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);
  const [receipt, setReceipt] = useState<any>(null);
  const idem = useRef<string>('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setLeft(Math.max(0, Math.floor((new Date(hold.expiresAt).getTime() - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [hold]);
  useEffect(() => { headingRef.current?.focus(); }, [step]);

  async function pick(s: { startsAt: string }, label: string) {
    setError(null);
    if (!loggedIn) return;
    setBusy(true);
    try {
      idem.current = crypto.randomUUID();
      const r = await fetch('/api/v1/slot-holds', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ offeringId: offering.id, startsAt: s.startsAt }) });
      const d = await r.json();
      if (!r.ok) {
        const alt = d.error?.details?.alternatives as any[] | undefined;
        setError(`${d.error?.message ?? 'Não foi possível reservar.'}${alt?.length ? ' Outros horários: ' + alt.slice(0, 3).map((a) => `${a.localDate.split('-').reverse().slice(0, 2).join('/')} ${a.localTime}`).join(', ') + '.' : ''}`);
        if (d.error?.code === 'mfa_required') window.location.href = '/entrar?etapa=mfa';
        return;
      }
      setHold(d); setSlot({ startsAt: s.startsAt, label }); setStep('review');
      setLeft(Math.floor((new Date(d.expiresAt).getTime() - Date.now()) / 1000));
    } catch { setError('Falha de rede. Nada foi reservado.'); } finally { setBusy(false); }
  }

  async function confirm() {
    if (!hold) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/v1/appointments', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'idempotency-key': idem.current },
        body: JSON.stringify({ holdId: hold.holdId, payerType: payer, insuranceProductId: payer === 'insurance' ? product : undefined, expectedPriceCents: payer === 'private' ? offering.priceCents : undefined }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error?.message ?? 'Não foi possível confirmar.');
        if (['hold_expired', 'slot_conflict', 'price_changed'].includes(d.error?.code)) { setStep('pick'); setHold(null); }
        return;
      }
      setReceipt(d); setStep('done');
    } catch { setError('Falha de rede. Se a tela não confirmar, consulte “Meus agendamentos” antes de tentar novamente.'); } finally { setBusy(false); }
  }

  async function back() {
    if (hold) await fetch(`/api/v1/slot-holds/${hold.holdId}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    setHold(null); setStep('pick'); setError(null);
  }

  if (step === 'done') {
    return (
      <div role="status">
        <h3 ref={headingRef} tabIndex={-1}>{receipt.status === 'pending_approval' ? 'Solicitação enviada — aguardando autorização' : 'Agendamento confirmado'}</h3>
        <p>{slot?.label} — {offering.service}</p><p>{offering.address}</p>
        {receipt.status === 'pending_approval' && <p className="banner">Este convênio exige autorização. O horário está reservado, mas <strong>ainda não está confirmado</strong> até a resposta da clínica.</p>}
        <p className="small">Pagamento diretamente no local. Comprovante: {receipt.id}</p>
        <p><Link className="btn" href={`/app/agendamentos/${receipt.id}`}>Ver agendamento</Link></p>
      </div>
    );
  }

  if (step === 'review' && slot) {
    const mm = String(Math.floor(left / 60)).padStart(2, '0'), ss = String(left % 60).padStart(2, '0');
    return (
      <div>
        <h3 ref={headingRef} tabIndex={-1}>Revise antes de confirmar</h3>
        <p role="timer" aria-live="off">Horário reservado por {mm}:{ss}</p>
        <ul>
          <li><strong>Quando:</strong> {slot.label} ({offering.timezone})</li>
          <li><strong>Serviço:</strong> {offering.service}</li>
          <li><strong>Onde:</strong> {offering.address}</li>
        </ul>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend>Forma de atendimento</legend>
          {offering.acceptsPrivate && <label className="inline"><input type="radio" name="payer" checked={payer === 'private'} onChange={() => setPayer('private')} />Particular — {offering.priceInformed ? brl(offering.priceCents!) : 'valor não informado pelo profissional'} (pagamento no local)</label>}
          {offering.insurance.length > 0 && <label className="inline"><input type="radio" name="payer" checked={payer === 'insurance'} onChange={() => setPayer('insurance')} />Convênio</label>}
          {payer === 'insurance' && (<><label htmlFor="prod">Produto/plano</label><select id="prod" value={product} onChange={(e) => setProduct(e.target.value)}>{offering.insurance.map((i) => <option key={i.id ?? i.label} value={i.id ?? ''}>{i.label}</option>)}</select></>)}
        </fieldset>
        <p className="small">Não informe sintomas ou dados clínicos. Você poderá cancelar ou reagendar pelo aplicativo, sem multa automática. Veja os <Link href="/termos">Termos</Link> e a <Link href="/cancelamentos">Política de Cancelamentos</Link>.</p>
        <label className="inline"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />Li as condições acima e quero confirmar este agendamento.</label>
        <div className="row" style={{ marginTop: '1rem' }}>
          <button type="button" onClick={confirm} disabled={!accepted || busy || left <= 0}>{busy ? 'Confirmando…' : 'Confirmar agendamento'}</button>
          <button type="button" className="secondary" onClick={back}>Escolher outro horário</button>
        </div>
        {left <= 0 && <p role="alert" className="field-error">A reserva expirou. Escolha o horário novamente.</p>}
        {error && <p role="alert" className="field-error">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      {!loggedIn && <p className="banner info">Para reservar um horário, <Link href={loginHref}>entre</Link> ou <Link href="/cadastro">crie sua conta</Link> (gratuito). Você pode ver os horários sem conta.</p>}
      {error && <p role="alert" className="field-error">{error}</p>}
      {days.map((d) => (
        <div key={d.date}>
          <h3>{d.label}</h3>
          <div className="slots" role="group" aria-label={`Horários de ${d.label}`}>
            {d.slots.map((s) => (
              <button key={s.startsAt} type="button" className="secondary" disabled={busy || !loggedIn} onClick={() => pick(s, `${d.label} às ${s.time}`)}>{s.time}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
