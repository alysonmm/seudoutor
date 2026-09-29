import { describe, it, expect, afterAll } from 'vitest';
import { call, rnd } from './helpers';
import { makeWorld, makeAdmin, specialtyId, nextCrm, addInsurance, patientSession } from './world';
import { closePool, one, query } from '../src/server/db';
import { searchPractitioners, publicProfile, haversineKm } from '../src/server/modules/search';
import { saveIdentity, submitForReview, reviewVersion, suspendPractitioner, reinstatePractitioner } from '../src/server/modules/credentialing';
import { createHold, bookAppointment } from '../src/server/modules/booking';
import * as searchRoute from '../src/app/api/v1/practitioners/route';
import * as profileRoute from '../src/app/api/v1/practitioners/[slug]/route';
import * as reviewRoute from '../src/app/api/v1/admin/credentialing/[versionId]/review/route';
import * as queueRoute from '../src/app/api/v1/admin/credentialing/route';
import * as identityRoute from '../src/app/api/v1/organizations/[orgId]/practitioners/[pid]/identity/route';

afterAll(async () => { await closePool(); });

const evidence = { source: 'consulta oficial manual (teste)', registration: 'CRM/SP teste', situation: 'Regular', checkedAt: '2026-09-01', nextReviewAt: '2027-03-01' };

describe('credenciamento (AC06, AC07)', () => {
  it('AC06: profissional pendente não aparece na busca, no perfil nem recebe marcação', async () => {
    const w = await makeWorld({ approve: false, city: 'Cidade Pendente ' + rnd() });
    const p = await one<any>('SELECT status, slug FROM practitioners WHERE id=$1', [w.pid]);
    expect(p.status).toBe('pending_review');
    const s = await searchPractitioners({ city: (await one<any>('SELECT city FROM locations WHERE id=$1', [w.locationId])).city });
    expect(s.total).toBe(0);
    expect(p.slug).toBeNull();
    const pat = await patientSession();
    await expect(createHold(pat.user.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt })).rejects.toMatchObject({ code: 'practitioner_not_bookable' });
    await expect(bookAppointment(pat.user.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' })).rejects.toMatchObject({ code: 'practitioner_not_bookable' });
  });

  it('só a equipe de credenciamento revisa; aprovação exige evidência de verificação', async () => {
    const w = await makeWorld({ approve: false });
    const pat = await patientSession();
    const q = await call(queueRoute.GET, { cookie: pat.cookie });
    expect(q.status).toBe(403);
    const v = await one<any>("SELECT id FROM public_profile_versions WHERE practitioner_id=$1 AND status='pending_review'", [w.pid]);
    const noEv = await call(reviewRoute.POST, { cookie: w.admin.cookie, params: { versionId: v.id }, body: { decision: 'approve' } });
    expect(noEv.status).toBe(400);
    expect(noEv.data.error.code).toBe('evidence_required');
    const ok = await call(reviewRoute.POST, { cookie: w.admin.cookie, params: { versionId: v.id }, body: { decision: 'approve', evidence } });
    expect(ok.status).toBe(200);
    const chk = await one<any>('SELECT * FROM credential_checks WHERE practitioner_id=$1', [w.pid]);
    expect(chk.checked_by).toBe(w.admin.user.id);
    expect(chk.source).toContain('consulta oficial');
    const prof = await publicProfile((await one<any>('SELECT slug FROM practitioners WHERE id=$1', [w.pid])).slug);
    expect(prof!.verification).toMatch(/registro verificado em \d{2}\/\d{2}\/\d{4}/);
    expect(JSON.stringify(prof)).not.toMatch(/CFM|certificad/i); // sem sugerir endosso
  });

  it('CRM+UF duplicado em outra identidade é recusado', async () => {
    const a = await makeWorld();
    const b = await makeWorld({ approve: false });
    const crm = (await one<any>('SELECT number FROM professional_registrations WHERE practitioner_id=$1', [a.pid])).number;
    const r = await call(identityRoute.PUT, {
      method: 'PUT', cookie: b.org.cookie, params: { orgId: b.orgId, pid: b.pid },
      body: { displayName: 'Outro Nome', registrations: [{ uf: 'SP', number: crm }], specialties: [{ specialtyId: await specialtyId() }] },
    });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('registration_in_use');
  });

  it('AC07: editar especialidade/RQE/nome cria nova versão pendente; a publicação segue na versão aprovada', async () => {
    const w = await makeWorld({ name: 'Dra. Original ' + rnd() });
    const slug = (await one<any>('SELECT slug FROM practitioners WHERE id=$1', [w.pid])).slug;
    const before = await publicProfile(slug);
    await saveIdentity(w.org.user.id, w.orgId, w.pid, {
      displayName: 'Dra. Nome Alterado', registrations: [{ uf: 'SP', number: (await one<any>('SELECT number FROM professional_registrations WHERE practitioner_id=$1', [w.pid])).number }],
      specialties: [{ specialtyId: await specialtyId('dermatologia'), rqe: '99999' }],
    });
    const { versionId } = await submitForReview(w.org.user.id, w.orgId, w.pid);
    const during = await publicProfile(slug);
    expect(during!.displayName).toBe(before!.displayName); // nome antigo continua
    expect(during!.specialties[0].name).toBe('Cardiologia');
    expect((await one<any>('SELECT status FROM public_profile_versions WHERE id=$1', [versionId])).status).toBe('pending_review');
    await reviewVersion(w.admin.user.id, versionId, { decision: 'approve', evidence });
    const after = await publicProfile(slug);
    expect(after!.displayName).toBe('Dra. Nome Alterado');
    expect(after!.specialties[0].name).toBe('Dermatologia');
    // campos de baixo risco não exigem revisão
    const { updatePublicFields } = await import('../src/server/modules/credentialing');
    await updatePublicFields(w.org.user.id, w.orgId, w.pid, { bio: 'Atendimento <script>alert(1)</script> adulto', languages: ['Português', 'Inglês'] });
    const p2 = await publicProfile(slug);
    expect(p2!.bio).not.toContain('<');
    expect(p2!.languages).toContain('Inglês');
  });

  it('suspensão: some da busca, bloqueia novas marcações e sinaliza consultas existentes (sem apagá-las)', async () => {
    const w = await makeWorld({ city: 'Cidade Susp ' + rnd() });
    const pat = await patientSession();
    const appt = await bookAppointment(pat.user.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await suspendPractitioner(w.admin.user.id, w.pid, 'Denúncia em apuração (teste)');
    const city = (await one<any>('SELECT city FROM locations WHERE id=$1', [w.locationId])).city;
    expect((await searchPractitioners({ city })).total).toBe(0);
    const pat2 = await patientSession();
    await expect(createHold(pat2.user.id, { offeringId: w.offeringId, startsAt: w.slots[1].startsAt })).rejects.toMatchObject({ code: 'practitioner_not_bookable' });
    const a = await one<any>('SELECT status, needs_followup, followup_reason FROM appointments WHERE id=$1', [appt.body.id]);
    expect(a.status).toBe('scheduled');
    expect(a.needs_followup).toBe(true);
    expect(await one("SELECT 1 FROM outbox_events WHERE event_type='PractitionerSuspended'")).toBeTruthy();
    await reinstatePractitioner(w.admin.user.id, w.pid, 'Apuração concluída (teste)');
    expect((await searchPractitioners({ city })).total).toBe(1);
  });

  it('sem assinatura/teste vigente o perfil não é publicado', async () => {
    const w = await makeWorld({ plan: null, city: 'Cidade SemPlano ' + rnd() });
    const city = (await one<any>('SELECT city FROM locations WHERE id=$1', [w.locationId])).city;
    expect((await searchPractitioners({ city })).total).toBe(0);
  });
});

describe('busca pública', () => {
  it('filtra por cidade/plano/preço, respeita preço desconhecido ≠ R$ 0 e só expõe campos permitidos', async () => {
    const city = 'Cidade Busca ' + rnd();
    const a = await makeWorld({ city, price: 30000, name: 'Dr. Alfa ' + rnd() });
    const b = await makeWorld({ city, price: null, name: 'Dr. Beta ' + rnd() });
    const prod = await addInsurance(a);
    const all = await searchPractitioners({ city });
    expect(all.total).toBe(2);
    const beta = all.items.find((i) => i.practitionerId === b.pid)!;
    expect(beta.priceKnown).toBe(false);
    expect(beta.minPriceCents).toBeNull();
    expect((await searchPractitioners({ city, maxPriceCents: 50000 })).items.map((i) => i.practitionerId)).toEqual([a.pid]); // desconhecido não casa
    expect((await searchPractitioners({ city, insuranceProductId: prod })).items.map((i) => i.practitionerId)).toEqual([a.pid]);
    expect((await searchPractitioners({ city, patientAge: 200 as any }).catch(() => ({ total: -1 }))).total).toBe(-1); // validação
    const raw = JSON.stringify(all);
    for (const forbidden of ['email', 'user_id', 'password', 'organization_id', 'rating', 'nota', 'avalia']) expect(raw.toLowerCase()).not.toContain(forbidden);
    expect(all.items[0].nextSlot).toBeTruthy();
    expect(all.items[0].verification).toMatch(/registro verificado em/);
  });

  it('ordenação é estável e não depende do plano contratado', async () => {
    const city = 'Cidade Ordem ' + rnd();
    const cheap = await makeWorld({ city, plan: 'essencial', name: 'Dr. Zeta ' + rnd() });
    const rich = await makeWorld({ city, plan: 'clinica', name: 'Dr. Alfa ' + rnd() });
    const r1 = await searchPractitioners({ city });
    const r2 = await searchPractitioners({ city });
    expect(r1.items.map((i) => i.practitionerId)).toEqual(r2.items.map((i) => i.practitionerId));
    // mesma agenda => desempate por nome, não pelo plano (o plano mais caro tem nome 'Alfa' por acaso; invertemos para provar)
    await (await import('../src/server/db')).query('UPDATE public_profile_versions SET data = jsonb_set(data, \'{display_name}\', \'"Dr. Aaa"\') WHERE practitioner_id=$1', [cheap.pid]);
    await (await import('../src/server/db')).query('UPDATE public_profile_versions SET data = jsonb_set(data, \'{display_name}\', \'"Dr. Zzz"\') WHERE practitioner_id=$1', [rich.pid]);
    const r3 = await searchPractitioners({ city, sort: 'price' });
    expect(r3.items[0].practitionerId).toBe(cheap.pid); // mesmo preço => nome; plano não pesa
  });

  it('distância em linha reta (haversine) e filtro por raio', async () => {
    const city = 'Cidade Geo ' + rnd();
    const near = await makeWorld({ city, lat: -23.55, lng: -46.63 });
    const far = await makeWorld({ city, lat: -22.9, lng: -43.2 });
    const r = await searchPractitioners({ city, lat: -23.56, lng: -46.64, maxKm: 20, sort: 'distance' });
    expect(r.items.map((i) => i.practitionerId)).toEqual([near.pid]);
    expect(r.items[0].distanceKm).toBeLessThan(5);
    expect(Math.round(haversineKm([-23.55, -46.63], [-22.9, -43.2]))).toBeGreaterThan(300);
    expect(far.pid).toBeTruthy();
  });

  it('API pública responde sem autenticação e o slug inexistente é 404', async () => {
    const w = await makeWorld({ city: 'Cidade Api ' + rnd() });
    const r = await call(searchRoute.GET, { url: 'http://localhost:3000/api/v1/practitioners?city=' + encodeURIComponent((await one<any>('SELECT city FROM locations WHERE id=$1', [w.locationId])).city) });
    expect(r.status).toBe(200);
    expect(r.data.items.length).toBe(1);
    const slug = r.data.items[0].slug;
    expect((await call(profileRoute.GET, { params: { slug } })).status).toBe(200);
    expect((await call(profileRoute.GET, { params: { slug: 'nao-existe' } })).status).toBe(404);
    expect((await query('SELECT 1 FROM users LIMIT 1')).length).toBeGreaterThan(0);
  });
});

describe('admin', () => {
  it('helpers de teste criam equipe de plataforma', async () => {
    const a = await makeAdmin('platform_admin');
    expect(a.cookie).toContain('sid=');
    expect(nextCrm()).toMatch(/^\d+$/);
  });
});
