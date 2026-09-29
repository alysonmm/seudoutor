import { DateTime } from 'luxon';
import { one, pool } from '../src/server/db';
import { newStaffOrg, newUser, rnd, sessionFor, setPlan, type TestUser } from './helpers';
import { saveIdentity, submitForReview, reviewVersion } from '../src/server/modules/credentialing';
import { createLocation, createService, upsertOffering, setAcceptedInsurance } from '../src/server/modules/catalog';
import { createRule } from '../src/server/modules/availability';
import { computeSlots, loadOffering, type Slot } from '../src/server/modules/availability';

export async function specialtyId(slug = 'cardiologia') {
  return (await one<{ id: string }>('SELECT id FROM specialties WHERE slug=$1', [slug]))!.id;
}

export async function makeAdmin(role: 'moderator' | 'platform_admin' | 'security_admin' | 'support' = 'moderator') {
  const u = await newUser('Admin ' + rnd());
  await pool().query('INSERT INTO platform_staff(user_id, role_id) VALUES ($1,$2)', [u.id, role]);
  const cookie = await sessionFor(u);
  return { user: u, cookie };
}

let crmSeq = 100000 + Math.floor(Math.random() * 800000);
export const nextCrm = () => String(crmSeq++);

export interface World {
  org: Awaited<ReturnType<typeof newStaffOrg>>;
  orgId: string; pid: string; locationId: string; serviceId: string; offeringId: string;
  admin: Awaited<ReturnType<typeof makeAdmin>>;
  slots: Slot[];
}

/** Consultório completo e aprovado, com agenda seg–dom 08:00–12:00 (passo 30 min, consulta de 30 min). */
export async function makeWorld(opts: {
  approve?: boolean; city?: string; price?: number | null; timezone?: string; plan?: 'essencial' | 'profissional' | 'clinica' | null;
  lat?: number; lng?: number; name?: string;
} = {}): Promise<World> {
  const org = await newStaffOrg('individual', true);
  if (opts.plan !== null) await setPlan(org.organizationId, opts.plan ?? 'profissional');
  const pid = org.practitionerId!;
  const admin = await makeAdmin('moderator');
  await saveIdentity(org.user.id, org.organizationId, pid, {
    displayName: opts.name ?? `Dr(a). ${rnd()} Silva`, registrations: [{ uf: 'SP', number: nextCrm() }],
    specialties: [{ specialtyId: await specialtyId(), rqe: '12345' }],
  });
  const { versionId } = await submitForReview(org.user.id, org.organizationId, pid);
  if (opts.approve !== false) {
    await reviewVersion(admin.user.id, versionId, {
      decision: 'approve',
      evidence: { source: 'consulta oficial manual (teste)', registration: 'CRM/SP teste', situation: 'Regular', checkedAt: '2026-09-01', nextReviewAt: '2027-03-01' },
    });
  }
  const loc = await createLocation(org.user.id, org.organizationId, {
    name: 'Sede', street: 'Rua das Flores', number: '100', neighborhood: 'Centro', city: opts.city ?? 'Cidade Teste', uf: 'SP',
    latitude: opts.lat ?? -23.55, longitude: opts.lng ?? -46.63, timezone: opts.timezone ?? 'America/Sao_Paulo', accessibility: ['rampa'],
  });
  const svc = await createService(org.user.id, org.organizationId, 'Consulta ' + rnd());
  const off = await upsertOffering(org.user.id, org.organizationId, {
    practitionerId: pid, locationId: loc.id, serviceId: svc.id, durationMinutes: 30, priceCents: opts.price === undefined ? 25000 : opts.price,
    paymentMethods: ['pix', 'cartão'],
  });
  for (let wd = 1; wd <= 7; wd++) {
    await createRule(org.user.id, org.organizationId, { practitionerId: pid, locationId: loc.id, weekday: wd, startTime: '08:00', endTime: '12:00', slotStepMinutes: 30 });
  }
  const o = (await loadOffering(off.id))!;
  const from = DateTime.now().setZone(o.timezone).plus({ days: 2 }).toISODate()!;
  const to = DateTime.now().setZone(o.timezone).plus({ days: 6 }).toISODate()!;
  const slots = await computeSlots(o, from, to);
  return { org, orgId: org.organizationId, pid, locationId: loc.id, serviceId: svc.id, offeringId: off.id, admin, slots };
}

/** Adiciona um convênio aceito à oferta e devolve o id do produto. */
export async function addInsurance(w: World, requiresAuthorization = false) {
  const ins = await one<{ id: string }>('INSERT INTO insurers(name) VALUES ($1) RETURNING id', ['Operadora ' + rnd()]);
  const prod = await one<{ id: string }>('INSERT INTO insurance_products(insurer_id, name) VALUES ($1,$2) RETURNING id', [ins!.id, 'Produto ' + rnd()]);
  await setAcceptedInsurance(w.org.user.id, w.orgId, w.offeringId, [{ insuranceProductId: prod!.id, requiresAuthorization }]);
  return prod!.id;
}

/** Segundo consultório para o MESMO profissional (mesma identidade global). */
export async function attachSecondOrg(w: World) {
  const other = await newStaffOrg('individual', false);
  await setPlan(other.organizationId, 'profissional');
  await pool().query('INSERT INTO practitioner_memberships(organization_id, practitioner_id) VALUES ($1,$2)', [other.organizationId, w.pid]);
  const loc = await createLocation(other.user.id, other.organizationId, {
    name: 'Filial', street: 'Rua B', neighborhood: 'Bairro', city: 'Cidade Teste', uf: 'SP', timezone: 'America/Sao_Paulo', accessibility: [],
  });
  const svc = await createService(other.user.id, other.organizationId, 'Consulta ' + rnd());
  // o gestor da segunda organização precisa do escopo: usa insert direto do vínculo profissional->serviço
  const off = await one<{ id: string }>(
    `INSERT INTO practitioner_services(organization_id, practitioner_id, location_id, service_id, duration_minutes) VALUES ($1,$2,$3,$4,30) RETURNING id`,
    [other.organizationId, w.pid, loc.id, svc.id]);
  for (let wd = 1; wd <= 7; wd++) {
    await pool().query(`INSERT INTO availability_rules(organization_id, practitioner_id, location_id, weekday, start_time, end_time, slot_step_minutes) VALUES ($1,$2,$3,$4,'08:00','12:00',30)`,
      [other.organizationId, w.pid, loc.id, wd]);
  }
  return { other, locationId: loc.id, offeringId: off!.id };
}

export async function patientSession(name = 'Paciente Teste'): Promise<{ user: TestUser; cookie: string }> {
  const user = await newUser(name);
  return { user, cookie: await sessionFor(user) };
}
