'use client';
export default function LogoutButton() {
  async function out() {
    try { await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* segue */ }
    try { sessionStorage.clear(); localStorage.clear(); if ('caches' in window) (await caches.keys()).forEach((k) => caches.delete(k)); } catch { /* ignore */ }
    window.location.href = '/';
  }
  return <button type="button" className="secondary" onClick={out}>Sair</button>;
}
