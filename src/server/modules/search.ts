import { z } from 'zod';
import { DateTime } from 'luxon';
import { query, one } from '../db';
import { computeSlots, nextSlot, loadOffering, type Slot } from './availability';
import { config } from '../config';

/**
 * Regra ÚNICA de "agendável": médico aprovado (e não suspenso) com versão de identidade aprovada,
 * vínculo ativo, organização ativa com direito de uso (assinatura/teste vigente), local e oferta ativos.
 * Usada pela busca, pelo perfil público e pela reserva.
 */
export const BOOKABLE_SQL = `
  p.status = 'approved' AND p.current_public_version_id IS NOT NULL
  AND pm.status = 'active' AND o.status = 'active'
  AND l.active AND ps.active
  AND EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.organization_id = o.id AND (
        (sub.status = 'trialing' AND sub.trial_ends_at > now()) OR sub.status IN ('active','grace_period')
        OR (sub.status = 'cancel_at_period_end' AND sub.current_period_end > now())))`;

export const searchSchema = z.object({
  q: z.string().trim().max(80).optional(),
  specialty: z.string().max(60).optional(),
  city: z.string().trim().max(80).optional(),
  neighborhood: z.string().trim().max(80).optional(),
  insuranceProductId: z.string().uuid().optional(),
  private: z.coerce.boolean().optional(),
  maxPriceCents: z.coerce.number().int().min(0).optional(),
  date: z.string().date().optional(),
  timeFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timeTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  patientAge: z.coerce.number().int().min(0).max(120).optional(),
  accessibility: z.string().max(60).optional(),
  language: z.string().max(30).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  maxKm: z.coerce.number().min(0.5).max(200).optional(),
  sort: z.enum(['next_slot', 'distance', 'price']).default('next_slot'),
  page: z.coerce.number().int().min(1).max(50).default(1),
});

/** Distância em linha reta (haversine) — aproximada, e a UI a identifica como tal. */
export const haversineKm = (a: [number, number], b: [number, number]) => {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const PAGE = 20;

export interface SearchItem {
  practitionerId: string; slug: string; displayName: string; specialties: { name: string; rqe: string | null }[];
  verification: string; locationId: string; city: string; neighborhood: string; uf: string;
  minPriceCents: number | null; priceKnown: boolean; acceptsPrivate: boolean; nextSlot: Slot | null; distanceKm: number | null;
  services: { offeringId: string; name: string; priceCents: number | null; durationMinutes: number }[];
}

/** Retorna SOMENTE campos públicos permitidos, apenas de perfis aprovados/publicados. Sem avaliações (módulo bloqueado). */
export async function searchPractitioners(raw: z.input<typeof searchSchema>) {
  const f = searchSchema.parse(raw);
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [BOOKABLE_SQL];
  if (f.q) { const t = p(`%${f.q.toLowerCase()}%`); where.push(`(lower(v.data->>'display_name') LIKE ${t} OR lower(s.name) LIKE ${t})`); }
  if (f.specialty) where.push(`sp.slug = ${p(f.specialty)}`);
  if (f.city) where.push(`lower(l.city) = ${p(f.city.toLowerCase())}`);
  if (f.neighborhood) where.push(`lower(l.neighborhood) = ${p(f.neighborhood.toLowerCase())}`);
  if (f.insuranceProductId) where.push(`EXISTS (SELECT 1 FROM accepted_insurance_products a WHERE a.practitioner_service_id = ps.id AND a.insurance_product_id = ${p(f.insuranceProductId)})`);
  if (f.private) where.push('ps.accepts_private');
  if (f.maxPriceCents != null) where.push(`ps.price_cents IS NOT NULL AND ps.price_cents <= ${p(f.maxPriceCents)}`); // preço desconhecido não casa com filtro de preço
  if (f.patientAge != null) { const a = p(f.patientAge); where.push(`(pr.age_min IS NULL OR pr.age_min <= ${a}) AND (pr.age_max IS NULL OR pr.age_max >= ${a})`); }
  if (f.accessibility) where.push(`${p(f.accessibility)} = ANY(l.accessibility)`);
  if (f.language) where.push(`${p(f.language)} = ANY(pr.languages)`);
  const rows = await query<any>(
    `SELECT p.id AS practitioner_id, p.slug, v.data AS ident, pr.languages, l.id AS location_id, l.city, l.neighborhood, l.uf, l.latitude, l.longitude, l.timezone,
            ps.id AS offering_id, s.name AS service_name, ps.price_cents, ps.accepts_private, ps.duration_minutes,
            (SELECT checked_at::text FROM credential_checks c WHERE c.profile_version_id = p.current_public_version_id ORDER BY c.checked_at DESC LIMIT 1) AS verified_on
       FROM practitioner_services ps
       JOIN practitioners p ON p.id = ps.practitioner_id
       JOIN practitioners pr ON pr.id = p.id
       JOIN public_profile_versions v ON v.id = p.current_public_version_id
       JOIN practitioner_memberships pm ON pm.practitioner_id = p.id AND pm.organization_id = ps.organization_id
       JOIN organizations o ON o.id = ps.organization_id
       JOIN locations l ON l.id = ps.location_id
       JOIN services s ON s.id = ps.service_id
       LEFT JOIN practitioner_specialties pspec ON pspec.practitioner_id = p.id
       LEFT JOIN specialties sp ON sp.id = pspec.specialty_id
      WHERE ${where.join(' AND ')}
      GROUP BY p.id, v.id, pr.id, l.id, ps.id, s.name`, params);

  // agrupa por profissional + local
  const map = new Map<string, SearchItem & { _offerings: string[] }>();
  for (const r of rows) {
    const key = `${r.practitioner_id}:${r.location_id}`;
    let it = map.get(key);
    if (!it) {
      const reg = r.ident.registrations?.[0];
      it = {
        practitionerId: r.practitioner_id, slug: r.slug, displayName: r.ident.display_name,
        specialties: r.ident.specialties.map((s: any) => ({ name: s.name, rqe: s.rqe })),
        verification: reg && r.verified_on ? `CRM/${reg.uf} ${reg.number} — registro verificado em ${DateTime.fromISO(r.verified_on).toFormat('dd/LL/yyyy')}` : 'Registro em verificação',
        locationId: r.location_id, city: r.city, neighborhood: r.neighborhood, uf: r.uf,
        minPriceCents: null, priceKnown: false, acceptsPrivate: false, nextSlot: null,
        distanceKm: f.lat != null && f.lng != null && r.latitude != null ? Math.round(haversineKm([f.lat, f.lng], [r.latitude, r.longitude]) * 10) / 10 : null,
        services: [], _offerings: [],
      };
      map.set(key, it);
    }
    it.services.push({ offeringId: r.offering_id, name: r.service_name, priceCents: r.price_cents, durationMinutes: r.duration_minutes });
    it._offerings.push(r.offering_id);
    if (r.price_cents != null) { it.priceKnown = true; it.minPriceCents = it.minPriceCents == null ? r.price_cents : Math.min(it.minPriceCents, r.price_cents); }
    if (r.accepts_private) it.acceptsPrivate = true;
  }
  let items = [...map.values()];
  if (f.maxKm != null && f.lat != null) items = items.filter((i) => i.distanceKm != null && i.distanceKm <= f.maxKm!);

  // próximo horário (e filtros de data/horário) — calculado com a mesma lógica da reserva
  for (const it of items) {
    let best: Slot | null = null;
    for (const oid of it._offerings) {
      const o = await loadOffering(oid);
      if (!o) continue;
      let s: Slot | null;
      if (f.date) {
        const day = await computeSlots(o, f.date, f.date);
        s = day.find((x) => (!f.timeFrom || x.localTime >= f.timeFrom) && (!f.timeTo || x.localTime <= f.timeTo)) ?? null;
      } else {
        const cands = await computeSlots(o, DateTime.now().setZone(o.timezone).toISODate()!, DateTime.now().setZone(o.timezone).plus({ days: 14 }).toISODate()!);
        s = cands.find((x) => (!f.timeFrom || x.localTime >= f.timeFrom) && (!f.timeTo || x.localTime <= f.timeTo)) ?? null;
      }
      if (s && (!best || s.startsAt < best.startsAt)) best = s;
    }
    it.nextSlot = best;
  }
  if (f.date || f.timeFrom || f.timeTo) items = items.filter((i) => i.nextSlot);

  // Ordenação documentada (docs/architecture.md): critério escolhido; desempate estável por nome e id.
  // Nenhum peso por plano/assinatura.
  const cmpStable = (a: SearchItem, b: SearchItem) => a.displayName.localeCompare(b.displayName, 'pt-BR') || (a.practitionerId + a.locationId).localeCompare(b.practitionerId + b.locationId);
  const nullsLast = (x: number | null, y: number | null) => (x == null ? (y == null ? 0 : 1) : y == null ? -1 : x - y);
  items.sort((a, b) => {
    if (f.sort === 'distance') return nullsLast(a.distanceKm, b.distanceKm) || cmpStable(a, b);
    if (f.sort === 'price') return nullsLast(a.minPriceCents, b.minPriceCents) || cmpStable(a, b);
    return nullsLast(a.nextSlot ? Date.parse(a.nextSlot.startsAt) : null, b.nextSlot ? Date.parse(b.nextSlot.startsAt) : null) || cmpStable(a, b);
  });
  const total = items.length;
  const page = items.slice((f.page - 1) * PAGE, f.page * PAGE).map(({ _offerings, ...rest }) => rest);
  return { total, page: f.page, pageSize: PAGE, items: page };
}

/** Perfil público por slug — mesma regra de agendável. */
export async function publicProfile(slug: string) {
  const p = await one<any>(
    `SELECT p.id, p.slug, p.bio, p.languages, p.age_min, p.age_max, v.data AS ident,
            (SELECT checked_at::text FROM credential_checks c WHERE c.profile_version_id = p.current_public_version_id ORDER BY c.checked_at DESC LIMIT 1) AS verified_on
       FROM practitioners p JOIN public_profile_versions v ON v.id = p.current_public_version_id
      WHERE p.slug=$1 AND p.status='approved'`, [slug]);
  if (!p) return null;
  const offers = await query<any>(
    `SELECT ps.id AS offering_id, ps.duration_minutes, ps.price_cents, ps.accepts_private, ps.payment_methods, ps.conditions, ps.return_policy,
            s.name AS service_name, l.id AS location_id, l.name AS location_name, l.street, l.number, l.neighborhood, l.city, l.uf, l.accessibility,
            l.arrival_instructions, l.latitude, l.longitude,
            COALESCE((SELECT json_agg(json_build_object('productId', ip.id, 'product', ip.name, 'insurer', i.name, 'requiresAuthorization', a.requires_authorization, 'updatedAt', a.updated_at))
                        FROM accepted_insurance_products a JOIN insurance_products ip ON ip.id = a.insurance_product_id JOIN insurers i ON i.id = ip.insurer_id
                       WHERE a.practitioner_service_id = ps.id), '[]') AS insurance
       FROM practitioner_services ps
       JOIN practitioners p ON p.id = ps.practitioner_id
       JOIN practitioner_memberships pm ON pm.practitioner_id = p.id AND pm.organization_id = ps.organization_id
       JOIN organizations o ON o.id = ps.organization_id
       JOIN locations l ON l.id = ps.location_id
       JOIN services s ON s.id = ps.service_id
      WHERE p.id=$1 AND ${BOOKABLE_SQL} ORDER BY l.name, s.name`, [p.id]);
  const reg = p.ident.registrations?.[0];
  return {
    practitionerId: p.id, slug: p.slug, displayName: p.ident.display_name, bio: p.bio, languages: p.languages,
    ageRange: p.age_min != null || p.age_max != null ? { min: p.age_min, max: p.age_max } : null,
    specialties: p.ident.specialties.map((s: any) => ({ name: s.name, rqe: s.rqe })),
    verification: reg && p.verified_on ? `CRM/${reg.uf} ${reg.number} — registro verificado em ${DateTime.fromISO(p.verified_on).toFormat('dd/LL/yyyy')}` : null,
    offerings: offers.map((o) => ({
      offeringId: o.offering_id, service: o.service_name, durationMinutes: o.duration_minutes,
      priceCents: o.price_cents, priceInformed: o.price_cents != null, acceptsPrivate: o.accepts_private, paymentMethods: o.payment_methods,
      conditions: o.conditions, returnPolicy: o.return_policy, insurance: o.insurance,
      location: { id: o.location_id, name: o.location_name, address: `${o.street}${o.number ? ', ' + o.number : ''} — ${o.neighborhood}, ${o.city}/${o.uf}`,
        accessibility: o.accessibility, arrivalInstructions: o.arrival_instructions },
    })),
  };
}

export async function publicAvailability(offeringId: string, from: string, to: string) {
  const ok = await one(
    `SELECT 1 FROM practitioner_services ps JOIN practitioners p ON p.id = ps.practitioner_id
       JOIN practitioner_memberships pm ON pm.practitioner_id = p.id AND pm.organization_id = ps.organization_id
       JOIN organizations o ON o.id = ps.organization_id JOIN locations l ON l.id = ps.location_id
      WHERE ps.id=$1 AND ${BOOKABLE_SQL}`, [offeringId]);
  if (!ok) return null;
  const o = await loadOffering(offeringId);
  const slots = await computeSlots(o!, from, to);
  return { timezone: o!.timezone, slots }; // livre/ocupado apenas: nada de terceiros
}
export { nextSlot, config };
