'use client';
import { useState } from 'react';

/** Localização só sob ação explícita; nunca contínua; recusa não bloqueia a busca manual. */
export default function GeoButton() {
  const [msg, setMsg] = useState('');
  function ask(e: React.MouseEvent<HTMLButtonElement>) {
    const form = e.currentTarget.form!;
    if (!navigator.geolocation) { setMsg('Seu navegador não oferece localização. Use cidade ou bairro.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        (form.elements.namedItem('lat') as HTMLInputElement).value = String(p.coords.latitude);
        (form.elements.namedItem('lng') as HTMLInputElement).value = String(p.coords.longitude);
        (form.elements.namedItem('sort') as HTMLSelectElement).value = 'distance';
        setMsg('Localização aplicada apenas a esta busca. Clique em Buscar.');
      },
      () => setMsg('Sem problema: busque por cidade, bairro ou CEP.'),
      { maximumAge: 60000, timeout: 8000 },
    );
  }
  return (<><button type="button" className="secondary" onClick={ask}>Usar minha localização</button><span role="status" className="small muted">{msg}</span></>);
}
