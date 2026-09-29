import Link from 'next/link';
import { listSpecialties } from '@/server/modules/catalog';

export default async function Home() {
  const specialties = await listSpecialties().catch(() => []);
  return (
    <>
      <h1>Encontre seu médico e agende com clareza</h1>
      <p className="muted">Buscar → comparar → escolher horário → agendar → confirmar presença. Gratuito para pacientes.</p>
      <form action="/buscar" method="get" className="card" role="search" aria-label="Buscar médicos">
        <div className="grid cols-3">
          <div><label htmlFor="q">Nome ou especialidade</label><input id="q" name="q" type="search" autoComplete="off" /></div>
          <div><label htmlFor="specialty">Especialidade</label>
            <select id="specialty" name="specialty"><option value="">Todas</option>{specialties.map((s: any) => <option key={s.id} value={s.slug}>{s.name}</option>)}</select></div>
          <div><label htmlFor="city">Cidade</label><input id="city" name="city" autoComplete="address-level2" /></div>
        </div>
        <p><button type="submit">Buscar</button></p>
      </form>
      <div className="grid cols-3">
        <section className="card"><h2>Informação clara</h2><p>Registro profissional verificado manualmente, valor informado pelo médico e condições antes de confirmar.</p></section>
        <section className="card"><h2>Agenda atualizada</h2><p>Horários reais, sem urgência falsa. Se não houver vaga, mostramos outras datas.</p></section>
        <section className="card"><h2>Você no controle</h2><p>Confirme, reagende ou cancele pelo aplicativo, sem precisar ligar.</p></section>
      </div>
      <p className="small muted">O Seu Doutor não é plano de saúde e não garante cobertura. “Registro verificado” não é endosso do CFM nem certificação de qualidade clínica.</p>
    </>
  );
}
