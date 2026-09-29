import { z } from 'zod';
import { one, query, withTx } from '../db';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { authorizeOrg } from './authz';
import { assertWithinLimit } from './entitlements';
import { stripHtml } from './credentialing';

export const locationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  street: z.string().trim().min(2).max(150), number: z.string().max(20).optional(), complement: z.string().max(80).optional(),
  neighborhood: z.string().trim().min(2).max(80), city: z.string().trim().min(2).max(80), uf: z.string().length(2).toUpperCase(),
  postalCode: z.string().regex(/^\d{5}-?\d{3}$/).optional(),
  latitude: z.number().min(-90).max(90).nullish(), longitude: z.number().min(-180).max(180).nullish(),
  timezone: z.string().default('America/Sao_Paulo').refine((z) => { try { Intl.DateTimeFormat(undefined, { timeZone: z }); return true; } catch { return false; } }, 'Fuso IANA inválido'),
  accessibility: z.array(z.string().max(60)).max(15).default([]),
  arrivalInstructions: z.string().max(500).optional(), adminPhone: z.string().max(30).optional(),
});

export async function createLocation(actor: string, org: string, raw: z.input<typeof locationSchema>) {
  await authorizeOrg(actor, org, 'org.locations.manage');
  const l = locationSchema.parse(raw);
  if ((l.latitude == null) !== (l.longitude == null)) throw badRequest('coordinates_incomplete');
  await assertWithinLimit(org, 'locations');
  const r = await one<{ id: string }>(
    `INSERT INTO locations(organization_id,name,street,number,complement,neighborhood,city,uf,postal_code,latitude,longitude,timezone,accessibility,arrival_instructions,admin_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [org, l.name, l.street, l.number ?? null, l.complement ?? null, l.neighborhood, l.city, l.uf, l.postalCode ?? null, l.latitude ?? null, l.longitude ?? null,
     l.timezone, l.accessibility, l.arrivalInstructions ? stripHtml(l.arrivalInstructions) : null, l.adminPhone ?? null]);
  await audit({ actorUserId: actor, organizationId: org, action: 'location.created', objectType: 'location', objectId: r!.id });
  return { id: r!.id };
}
export async function listLocations(actor: string, org: string) {
  await authorizeOrg(actor, org, 'schedule.read');
  return query('SELECT * FROM locations WHERE organization_id=$1 ORDER BY name', [org]);
}

export async function createService(actor: string, org: string, name: string) {
  await authorizeOrg(actor, org, 'org.services.manage');
  const n = z.string().trim().min(2).max(100).parse(name);
  const r = await one<{ id: string }>('INSERT INTO services(organization_id, name) VALUES ($1,$2) RETURNING id', [org, n]);
  return { id: r!.id };
}

export const offeringSchema = z.object({
  practitionerId: z.string().uuid(), locationId: z.string().uuid(), serviceId: z.string().uuid(),
  durationMinutes: z.number().int().min(5).max(480), prepMinutes: z.number().int().min(0).max(120).default(0),
  bufferMinutes: z.number().int().min(0).max(120).default(0),
  priceCents: z.number().int().min(0).nullable().default(null), // null = não informado (nunca R$ 0)
  acceptsPrivate: z.boolean().default(true), paymentMethods: z.array(z.string().max(40)).max(10).default([]),
  conditions: z.string().max(500).optional(), returnPolicy: z.string().max(500).optional(),
});

/** Cria/atualiza oferta (serviço de um médico em um local). Preço fica na oferta; consultas guardam snapshot. */
export async function upsertOffering(actor: string, org: string, raw: z.input<typeof offeringSchema>) {
  const g = await authorizeOrg(actor, org, 'org.services.manage');
  const o = offeringSchema.parse(raw);
  if (!g.allowsPractitioner(o.practitionerId)) throw forbidden();
  const r = await one<{ id: string }>(
    `INSERT INTO practitioner_services(organization_id,practitioner_id,location_id,service_id,duration_minutes,prep_minutes,buffer_minutes,price_cents,accepts_private,payment_methods,conditions,return_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (practitioner_id, location_id, service_id) DO UPDATE SET
       duration_minutes=EXCLUDED.duration_minutes, prep_minutes=EXCLUDED.prep_minutes, buffer_minutes=EXCLUDED.buffer_minutes,
       price_cents=EXCLUDED.price_cents, accepts_private=EXCLUDED.accepts_private, payment_methods=EXCLUDED.payment_methods,
       conditions=EXCLUDED.conditions, return_policy=EXCLUDED.return_policy, active=true, updated_at=now()
     RETURNING id`,
    [org, o.practitionerId, o.locationId, o.serviceId, o.durationMinutes, o.prepMinutes, o.bufferMinutes, o.priceCents, o.acceptsPrivate, o.paymentMethods,
     o.conditions ? stripHtml(o.conditions) : null, o.returnPolicy ? stripHtml(o.returnPolicy) : null]);
  await audit({ actorUserId: actor, organizationId: org, action: 'offering.upserted', objectType: 'practitioner_service', objectId: r!.id });
  return { id: r!.id };
}

export async function setAcceptedInsurance(actor: string, org: string, offeringId: string, items: { insuranceProductId: string; requiresAuthorization?: boolean }[]) {
  const g = await authorizeOrg(actor, org, 'org.services.manage');
  await withTx(async (tx) => {
    const ps = await one<{ practitioner_id: string }>('SELECT practitioner_id FROM practitioner_services WHERE id=$1 AND organization_id=$2', [offeringId, org], tx);
    if (!ps) throw notFound();
    if (!g.allowsPractitioner(ps.practitioner_id)) throw forbidden();
    await tx.query('DELETE FROM accepted_insurance_products WHERE practitioner_service_id=$1', [offeringId]);
    for (const it of items) {
      const ok = await one('SELECT 1 FROM insurance_products WHERE id=$1 AND active', [it.insuranceProductId], tx);
      if (!ok) throw badRequest('unknown_insurance_product');
      await tx.query('INSERT INTO accepted_insurance_products(practitioner_service_id, insurance_product_id, requires_authorization) VALUES ($1,$2,$3)',
        [offeringId, it.insuranceProductId, !!it.requiresAuthorization]);
    }
    await audit({ actorUserId: actor, organizationId: org, action: 'offering.insurance_set', objectType: 'practitioner_service', objectId: offeringId }, tx);
  });
}

export async function listOfferings(actor: string, org: string) {
  const g = await authorizeOrg(actor, org, 'schedule.read');
  const f = g.practitionerFilter();
  return query(
    `SELECT ps.*, s.name AS service_name, l.name AS location_name FROM practitioner_services ps
       JOIN services s ON s.id = ps.service_id JOIN locations l ON l.id = ps.location_id
      WHERE ps.organization_id=$1 AND ($2::uuid[] IS NULL OR ps.practitioner_id = ANY($2::uuid[])) ORDER BY s.name`, [org, f]);
}

// Catálogo global (administração da plataforma) ------------------------------------------------
export async function listInsurers() {
  return query(`SELECT i.id, i.name, COALESCE(json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]') AS products
                  FROM insurers i LEFT JOIN insurance_products p ON p.insurer_id = i.id AND p.active WHERE i.active GROUP BY i.id ORDER BY i.name`);
}
export async function listSpecialties() { return query('SELECT id, slug, name FROM specialties WHERE active ORDER BY name'); }
