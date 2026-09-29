import { adminShell } from '@/components/AdminShell';
import { query } from '@/server/db';
import { listFlags } from '@/server/modules/flags';

export const metadata = { title: 'Configurações' };

export default async function Cfg() {
  const { allowed, nav } = await adminShell('/admin/configuracoes', 'feature.manage');
  const flags: any[] = allowed ? await listFlags() : [];
  const settings = allowed ? await query<any>('SELECT key, value, description FROM system_settings ORDER BY key') : [];
  const retention = allowed ? await query<any>('SELECT data_class, retention, status, basis FROM retention_policies ORDER BY data_class') : [];
  return (<><h1>Configurações</h1>{nav}
    {!allowed ? <div className="banner">Seu papel não tem permissão para esta área.</div> : (<>
      <h2>Módulos (feature flags — falha fechada)</h2>
      <p className="small">Flags reguladas só valem com aprovação humana registrada (referência, escopo, aprovador, revisão) e implementação existente. Nenhum módulo bloqueado tem implementação neste MVP.</p>
      <div className="table-wrap"><table><thead><tr><th scope="col">Módulo</th><th scope="col">Regulado</th><th scope="col">Implementado</th><th scope="col">Ligado</th></tr></thead>
        <tbody>{flags.map((f) => <tr key={f.key}><td>{f.key}<div className="small muted">{f.description}</div></td><td>{f.regulated ? 'sim' : 'não'}</td><td>{f.implemented ? 'sim' : 'não'}</td><td>{f.enabled ? 'sim' : 'não'}</td></tr>)}</tbody></table></div>
      <h2>Parâmetros</h2>
      <ul>{settings.map((s: any) => <li key={s.key}><code>{s.key}</code> = {JSON.stringify(s.value)} <span className="small muted">{s.description}</span></li>)}</ul>
      <h2>Retenção (propostas, não aprovadas)</h2>
      <ul>{retention.map((r: any) => <li key={r.data_class}><strong>{r.data_class}</strong>: {r.retention} — {r.status} — {r.basis}</li>)}</ul></>)}
  </>);
}
