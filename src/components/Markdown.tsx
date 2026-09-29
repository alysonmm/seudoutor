import type { ReactNode } from 'react';

/** Renderizador mínimo e seguro (sem HTML bruto): títulos, listas, citações, tabelas, negrito. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}
export default function Markdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (l.startsWith('# ')) out.push(<h1 key={i}>{inline(l.slice(2))}</h1>);
    else if (l.startsWith('## ')) out.push(<h2 key={i}>{inline(l.slice(3))}</h2>);
    else if (l.startsWith('> ')) out.push(<div key={i} className="banner" role="note">{inline(l.slice(2))}</div>);
    else if (l.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      i--; out.push(<ul key={i}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ul>);
    } else if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) { if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim())); i++; }
      i--; out.push(<div className="table-wrap" key={i}><table><thead><tr>{rows[0].map((c, k) => <th scope="col" key={k}>{c}</th>)}</tr></thead><tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);
    } else out.push(<p key={i}>{inline(l)}</p>);
  }
  return <div className="doc">{out}</div>;
}
