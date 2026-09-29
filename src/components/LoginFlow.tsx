'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import JsonForm from './JsonForm';

/** Login → (se exigido) verificação TOTP ou cadastro do segundo fator com códigos de recuperação. */
export default function LoginFlow({ next, startAtMfa }: { next: string; startAtMfa: boolean }) {
  const [stage, setStage] = useState<'login' | 'mfa' | 'enroll' | 'codes'>(startAtMfa ? 'mfa' : 'login');
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (startAtMfa) fetch('/api/v1/auth/me').then((r) => r.json()).then((d) => setStage(d?.mfa?.enrolled ? 'mfa' : 'enroll')).catch(() => {});
  }, [startAtMfa]);
  useEffect(() => {
    if (stage === 'enroll' && !enroll) fetch('/api/v1/auth/mfa/enroll', { method: 'POST', credentials: 'same-origin' }).then((r) => r.json()).then(setEnroll).catch(() => setError('Não foi possível iniciar o cadastro do segundo fator.'));
  }, [stage, enroll]);

  async function post(url: string, body: unknown) {
    setBusy(true); setError('');
    try {
      const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => null);
      if (!r.ok) { setError(d?.error?.message ?? 'Não foi possível concluir.'); return null; }
      return d;
    } catch { setError('Falha de rede. Tente novamente.'); return null; } finally { setBusy(false); }
  }
  const go = () => { window.location.href = next; };

  if (stage === 'login') {
    return (
      <form onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const d = await post('/api/v1/auth/login', { email: fd.get('email'), password: fd.get('password') });
        if (!d) return;
        if (d.mfaRequired) setStage(d.mfaEnrolled ? 'mfa' : 'enroll'); else go();
      }}>
        <label htmlFor="email">E-mail</label><input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Senha</label><input id="password" name="password" type="password" autoComplete="current-password" required />
        {error && <p role="alert" className="field-error">{error}</p>}
        <p><button type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button></p>
        <p className="small"><Link href="/recuperar-acesso">Esqueci minha senha</Link> • <Link href="/cadastro">Criar conta</Link></p>
      </form>
    );
  }
  if (stage === 'mfa') {
    return (
      <form onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const useRecovery = fd.get('recovery');
        const d = await post('/api/v1/auth/mfa/verify', useRecovery ? { recoveryCode: String(useRecovery).trim() } : { token: fd.get('token') });
        if (d) go();
      }}>
        <h2>Segundo fator de autenticação</h2>
        <label htmlFor="token">Código do aplicativo autenticador (6 dígitos)</label>
        <input id="token" name="token" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" />
        <details><summary>Perdi o acesso ao aplicativo</summary>
          <label htmlFor="recovery">Código de recuperação (uso único)</label><input id="recovery" name="recovery" autoComplete="off" /></details>
        {error && <p role="alert" className="field-error">{error}</p>}
        <p><button type="submit" disabled={busy}>Verificar</button></p>
      </form>
    );
  }
  if (stage === 'enroll') {
    return (
      <div>
        <h2>Ative o segundo fator</h2>
        <p>Profissionais, equipe e administração precisam de verificação em duas etapas. No aplicativo autenticador, adicione uma conta manualmente com esta chave:</p>
        {enroll ? <p><code aria-label="Chave secreta" style={{ wordBreak: 'break-all', fontSize: '1.1rem' }}>{enroll.secret}</code></p> : <p>Gerando chave…</p>}
        <form onSubmit={async (e) => {
          e.preventDefault();
          const d = await post('/api/v1/auth/mfa/confirm', { token: new FormData(e.currentTarget).get('token') });
          if (d) { setCodes(d.recoveryCodes); setStage('codes'); }
        }}>
          <label htmlFor="token">Código de 6 dígitos gerado</label>
          <input id="token" name="token" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required />
          {error && <p role="alert" className="field-error">{error}</p>}
          <p><button type="submit" disabled={busy || !enroll}>Ativar</button></p>
        </form>
      </div>
    );
  }
  return (
    <div>
      <h2>Guarde seus códigos de recuperação</h2>
      <p>Cada código funciona uma única vez e não será mostrado de novo.</p>
      <pre className="card">{codes.join('\n')}</pre>
      <p><button type="button" onClick={go}>Já guardei, continuar</button></p>
    </div>
  );
}
