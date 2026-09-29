'use client';
import { useState } from 'react';

/** A página abre por GET sem alterar nada; somente o clique dispara o POST (scanners de e-mail não cancelam consultas). */
export default function LinkAction({ token, action, when }: { token: string; action: 'confirm' | 'cancel'; when: string }) {
  const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await fetch('/api/v1/links/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, action }) });
      const d = await r.json().catch(() => null);
      setMsg(r.ok ? (action === 'confirm' ? 'Presença confirmada.' : 'Agendamento cancelado.') : d?.error?.message ?? 'Não foi possível concluir.');
    } catch { setMsg('Falha de rede. Nada foi alterado.'); } finally { setBusy(false); }
  }
  return (
    <div>
      <p>Agendamento em <strong>{when}</strong>.</p>
      <button type="button" className={action === 'cancel' ? 'danger' : undefined} disabled={busy || !!msg} onClick={run}>{action === 'confirm' ? 'Confirmar minha presença' : 'Cancelar este agendamento'}</button>
      <p role="status">{msg}</p>
    </div>
  );
}
