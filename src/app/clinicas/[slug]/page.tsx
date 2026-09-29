import { notFound } from 'next/navigation';
import Link from 'next/link';
import { query } from '@/server/db';
import { BOOKABLE_SQL } from '@/server/modules/search';

export default async function Clinica({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = (await query<any>("SELECT id, name FROM organizations WHERE slug=$1 AND status='active'", [slug]))[0];
  if (!org) notFound();
  const rows = await query<any>(
    `SELECT DISTINCT p.slug, v.data->>'display_name' name, l.name lname, l.city FROM practitioner_services ps JOIN practitioners p ON p.id=ps.practitioner_id
       JOIN public_profile_versions v ON v.id=p.current_public_version_id JOIN practitioner_memberships pm ON pm.practitioner_id=p.id AND pm.organization_id=ps.organization_id
       JOIN organizations o ON o.id=ps.organization_id JOIN locations l ON l.id=ps.location_id WHERE ps.organization_id=$1 AND ${BOOKABLE_SQL}`, [org.id]);
  return (<><h1>{org.name}</h1>
    {rows.length === 0 ? <div className="empty">Nenhum profissional com agenda aberta no momento.</div> : <ul>{rows.map((r: any) => <li key={r.slug + r.lname}><Link href={`/medicos/${r.slug}`}>{r.name}</Link> — {r.lname}, {r.city}</li>)}</ul>}</>);
}
