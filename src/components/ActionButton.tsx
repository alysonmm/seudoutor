'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Botão que chama um endpoint (POST/DELETE) e atualiza a página. Erros e sucesso em regiões anunciáveis. */
export default function ActionButton({ url, method = 'POST', body, label, confirm, variant, done }: {
  url: string; method?: 'POST' | 'DELETE' | 'PUT'; body?: unknown; label: string; confirm?: string; variant?: 'danger' | 'secondary'; done?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function go() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const t = await res.text(); const d = t ? JSON.parse(t) : null;
      if (!res.ok) setMsg({ ok: false, text: d?.error?.message ?? 'Não foi possível concluir.' });
      else { setMsg({ ok: true, text: done ?? 'Concluído.' }); router.refresh(); }
    } catch { setMsg({ ok: false, text: 'Falha de rede. Nada foi alterado.' }); }
    finally { setBusy(false); }
  }
  return (
    <span>
      <button type="button" className={variant} onClick={go} disabled={busy}>{busy ? 'Aguarde…' : label}</button>
      <span role="status" aria-live="polite" className="small" style={{ marginLeft: 8, color: msg?.ok ? 'var(--success)' : 'var(--danger)' }}>{msg?.text}</span>
    </span>
  );
}
