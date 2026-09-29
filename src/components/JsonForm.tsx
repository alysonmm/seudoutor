'use client';
import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export interface Field {
  name: string;                       // aceita notação com ponto: "patient.fullName"
  label: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'date' | 'datetime-local' | 'time' | 'select' | 'checkbox' | 'textarea' | 'list';
  options?: { value: string; label: string }[];
  required?: boolean;
  help?: string;
  autoComplete?: string;
  inputMode?: 'numeric' | 'text' | 'tel' | 'email';
  defaultValue?: string | number | boolean;
  maxLength?: number;
}

function setPath(obj: any, path: string, value: unknown) {
  const parts = path.split('.');
  let o = obj;
  parts.slice(0, -1).forEach((p, i) => { o[p] = o[p] ?? (/^\d+$/.test(parts[i + 1]) ? [] : {}); o = o[p]; });
  o[parts.at(-1)!] = value;
}

/** Erro devolvido pela API: mensagem geral + erros por campo associados por aria-describedby. */
export default function JsonForm(props: {
  action: string; method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; fields: Field[]; submitLabel: string;
  fixed?: Record<string, unknown>; successMessage?: string; redirectTo?: string; refresh?: boolean; idempotent?: boolean;
  onDoneHref?: string; secondary?: boolean; confirmText?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [ok, setOk] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (props.confirmText && !window.confirm(props.confirmText)) return;
    setBusy(true); setError(null); setFieldErrors({}); setOk(null);
    const fd = new FormData(e.currentTarget);
    const body: any = { ...(props.fixed ?? {}) };
    for (const f of props.fields) {
      let v: unknown;
      if (f.type === 'checkbox') v = fd.get(f.name) === 'on';
      else {
        const raw = String(fd.get(f.name) ?? '').trim();
        if (raw === '' && !f.required) continue;
        if (f.type === 'number') v = Number(raw);
        else if (f.type === 'list') v = raw.split(',').map((s) => s.trim()).filter(Boolean);
        else if (f.type === 'datetime-local') v = new Date(raw).toISOString();
        else v = raw;
      }
      setPath(body, f.name, v);
    }
    try {
      const res = await fetch(props.action, {
        method: props.method ?? 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(props.idempotent ? { 'idempotency-key': crypto.randomUUID() } : {}) },
        body: props.method === 'DELETE' && !props.fields.length ? undefined : JSON.stringify(body),
      });
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) {
        const err = data?.error;
        setError(err?.message ?? 'Não foi possível concluir. Tente novamente.');
        if (Array.isArray(err?.details)) {
          const fe: Record<string, string> = {};
          for (const d of err.details) if (d?.path) fe[d.path] = d.message;
          setFieldErrors(fe);
        }
        if (err?.details?.alternatives?.length) {
          setError(`${err.message} Alternativas: ${err.details.alternatives.map((s: any) => s.localDate + ' ' + s.localTime).join(', ')}`);
        }
        if (err?.code === 'mfa_required') router.push('/entrar?etapa=mfa');
      } else {
        setResult(data);
        setOk(props.successMessage ?? 'Concluído.');
        if (props.redirectTo) router.push(props.redirectTo);
        else if (props.refresh !== false) router.refresh();
      }
    } catch {
      setError('Falha de rede. Verifique sua conexão e tente novamente. Nada foi confirmado.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-describedby={error ? `${id}-err` : undefined}>
      {props.fields.map((f) => {
        const fid = `${id}-${f.name}`;
        const fe = fieldErrors[f.name];
        const common = {
          id: fid, name: f.name, required: f.required, 'aria-invalid': fe ? true : undefined,
          'aria-describedby': [fe ? `${fid}-e` : '', f.help ? `${fid}-h` : ''].filter(Boolean).join(' ') || undefined,
          autoComplete: f.autoComplete, maxLength: f.maxLength,
        } as const;
        return (
          <div key={f.name}>
            {f.type === 'checkbox' ? (
              <label className="inline" htmlFor={fid}>
                <input type="checkbox" {...common} defaultChecked={!!f.defaultValue} />
                <span>{f.label}</span>
              </label>
            ) : (
              <label htmlFor={fid}>{f.label}{f.required ? <span aria-hidden> *</span> : null}</label>
            )}
            {f.type === 'select' ? (
              <select {...common} defaultValue={String(f.defaultValue ?? '')}>
                {!f.required && <option value="">—</option>}
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea rows={4} {...common} defaultValue={String(f.defaultValue ?? '')} />
            ) : f.type === 'checkbox' ? null : (
              <input type={f.type === 'list' ? 'text' : f.type ?? 'text'} inputMode={f.inputMode} {...common} defaultValue={f.defaultValue as any} />
            )}
            {f.help && <div className="help" id={`${fid}-h`}>{f.help}</div>}
            {fe && <div className="field-error" id={`${fid}-e`}>{fe}</div>}
          </div>
        );
      })}
      <div className="row" style={{ marginTop: '1rem' }}>
        <button type="submit" disabled={busy} className={props.secondary ? 'secondary' : undefined}>{busy ? 'Enviando…' : props.submitLabel}</button>
      </div>
      <div aria-live="polite" role="status">
        {ok && <p style={{ color: 'var(--success)' }}>{ok}</p>}
        {result?.recoveryCodes && (
          <div className="banner info"><strong>Guarde seus códigos de recuperação (aparecem uma única vez):</strong>
            <pre>{result.recoveryCodes.join('\n')}</pre></div>
        )}
      </div>
      {error && <p id={`${id}-err`} role="alert" className="field-error">{error}</p>}
    </form>
  );
}
