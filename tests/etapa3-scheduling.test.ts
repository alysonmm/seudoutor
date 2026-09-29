import { describe, it, expect, afterAll } from 'vitest';
import { DateTime } from 'luxon';
import { call, newUser, rnd, sessionFor, setPlan, count, lastMailCode } from './helpers';
import { makeWorld, attachSecondOrg, patientSession, addInsurance } from './world';
import { closePool, one, query, pool } from '../src/server/db';
import * as B from '../src/server/modules/booking';
import { computeSlots, loadOffering, createBlock, deactivateRule, listRules } from '../src/server/modules/availability';
import { processOutbox, processDueJobs } from '../src/server/modules/notifications';
import { authorizeOrg } from '../src/server/modules/authz';
import { signLink } from '../src/server/lib/crypto';
import { upsertOffering } from '../src/server/modules/catalog';
import * as linkRoute from '../src/app/api/v1/links/[token]/route';
import * as linkAct from '../src/app/api/v1/links/act/route';
import * as apptsRoute from '../src/app/api/v1/appointments/route';
import * as cancelRoute from '../src/app/api/v1/appointments/[id]/cancel/route';
import * as orgApptsRoute from '../src/app/api/v1/organizations/[orgId]/appointments/route';
import * as loyaltyRoute from '../src/app/api/v1/loyalty/route';
import * as clinicalPay from '../src/app/api/v1/clinical-payments/route';
import * as tele from '../src/app/api/v1/telehealth/route';
import * as deps from '../src/app/api/v1/dependents/route';
import * as exams from '../src/app/api/v1/exams/route';
import * as reviews from '../src/app/api/v1/public-reviews/route';

afterAll(async () => { await closePool(); });

const occCount = (pid: string) => count("SELECT count(*) n FROM practitioner_occupancies WHERE practitioner_id=$1", [pid]);

describe('AC01 — reservas simultâneas', () => {
  it('10 pacientes confirmam o MESMO horário ao mesmo tempo: 1 confirmação, 9 conflitos, zero dupla ocupação', async () => {
    const w = await makeWorld();
    const users = await Promise.all(Array.from({ length: 10 }, () => newUser('Paciente ' + rnd())));
    const slot = w.slots[3].startsAt;
    const results = await Promise.allSettled(users.map((u) => B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: slot, payerType: 'private' })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(9);
    for (const b of bad) {
      expect(b.reason.code).toBe('slot_conflict');
      expect(b.reason.details.alternatives.length).toBeGreaterThan(0); // conflito devolve alternativas
      expect(b.reason.details.alternatives.map((s: any) => s.startsAt)).not.toContain(slot);
    }
    expect(await count("SELECT count(*) n FROM appointments WHERE practitioner_id=$1 AND status='scheduled'", [w.pid])).toBe(1);
    expect(await occCount(w.pid)).toBe(1);
  });

  it('reservas temporárias concorrentes no mesmo horário: só uma vence', async () => {
    const w = await makeWorld();
    const users = await Promise.all(Array.from({ length: 6 }, () => newUser()));
    const r = await Promise.allSettled(users.map((u) => B.createHold(u.id, { offeringId: w.offeringId, startsAt: w.slots[4].startsAt })));
    expect(r.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(await occCount(w.pid)).toBe(1);
  });

  it('horários sobrepostos por buffers também conflitam (duração+intervalo entram no cálculo)', async () => {
    const w = await makeWorld();
    await upsertOffering(w.org.user.id, w.orgId, { practitionerId: w.pid, locationId: w.locationId, serviceId: w.serviceId, durationMinutes: 30, bufferMinutes: 30, priceCents: 1000 });
    const a = await newUser(), b = await newUser();
    const o = (await loadOffering(w.offeringId))!;
    const slots = await computeSlots(o, w.slots[0].localDate, w.slots[0].localDate);
    await B.bookAppointment(a.id, { offeringId: w.offeringId, startsAt: slots[0].startsAt, payerType: 'private' });
    // o próximo slot (30 min depois) cai no intervalo de 30 min pós-consulta => não é mais oferecido
    const after = await computeSlots(o, w.slots[0].localDate, w.slots[0].localDate);
    expect(after.map((s) => s.startsAt)).not.toContain(slots[1].startsAt);
    await expect(B.bookAppointment(b.id, { offeringId: w.offeringId, startsAt: slots[1].startsAt, payerType: 'private' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('AC02 — médico em duas organizações', () => {
  it('bloqueio global sem revelar paciente da outra clínica', async () => {
    const w = await makeWorld();
    const s2 = await attachSecondOrg(w);
    const pat = await newUser('Maria Segredo da Silva');
    await B.bookAppointment(pat.id, { offeringId: w.offeringId, startsAt: w.slots[2].startsAt, payerType: 'private' });
    // a segunda clínica NÃO vê o horário como livre
    const o2 = (await loadOffering(s2.offeringId))!;
    const free = await computeSlots(o2, w.slots[2].localDate, w.slots[2].localDate);
    expect(free.map((s) => s.startsAt)).not.toContain(w.slots[2].startsAt);
    // e tentar marcar por lá falha, sem vazamento
    let err: any;
    try {
      await B.createManualAppointment(s2.other.user.id, s2.other.organizationId, {
        offeringId: s2.offeringId, startsAt: w.slots[2].startsAt, source: 'phone', patient: { fullName: 'Outro Paciente' },
      });
    } catch (e) { err = e; }
    // a gestora da 2ª org não tem escopo sobre o profissional (não é dela) OU recebe conflito; nunca dados da outra org
    expect(err).toBeTruthy();
    expect([403, 409]).toContain(err.status);
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toMatch(/Maria|Segredo/);
    // ocupação global não guarda dado pessoal
    const cols = await query("SELECT column_name FROM information_schema.columns WHERE table_name='practitioner_occupancies'");
    expect(cols.map((c) => c.column_name).sort()).toEqual(['created_at', 'during', 'expires_at', 'id', 'kind', 'practitioner_id', 'ref_id']);
    // constraint no banco: inserção direta sobreposta falha mesmo sem passar pela aplicação
    await expect(pool().query(
      `INSERT INTO practitioner_occupancies(practitioner_id, during, kind, ref_id) VALUES ($1, tstzrange($2::timestamptz, $2::timestamptz + interval '10 minutes'), 'appointment', gen_random_uuid())`,
      [w.pid, w.slots[2].startsAt])).rejects.toMatchObject({ code: '23P01' });
  });
});

describe('AC03/AC05 — isolamento e permissões', () => {
  it('secretária: escopo por médico, IDs adulterados negados, sem cobrança/exportação', async () => {
    const w = await makeWorld();
    await setPlan(w.orgId, 'clinica');
    const sec = await newUser('Secretária');
    const { inviteMember, acceptInvitation } = await import('../src/server/modules/orgs');
    const inv = await inviteMember(w.org.user.id, w.orgId, { email: sec.email, role: 'secretary', practitionerIds: [w.pid], locationIds: [] });
    await acceptInvitation(sec.id, inv.token);
    const secCookie = await sessionFor(sec);
    // permitido
    await expect(authorizeOrg(sec.id, w.orgId, 'appointment.create')).resolves.toBeTruthy();
    // AC05: negado
    for (const perm of ['billing.read', 'billing.manage', 'export.general', 'org.members.manage', 'reports.financial']) {
      await expect(authorizeOrg(sec.id, w.orgId, perm)).rejects.toMatchObject({ status: 403 });
    }
    // marcação manual válida
    const okAppt = await call(orgApptsRoute.POST, { cookie: secCookie, params: { orgId: w.orgId }, body: { offeringId: w.offeringId, startsAt: w.slots[5].startsAt, source: 'phone', patient: { fullName: 'Paciente Telefone' } } });
    expect(okAppt.status).toBe(200);
    // AC03: usa a organização de OUTRO consultório na rota
    const other = await makeWorld();
    const cross = await call(orgApptsRoute.POST, { cookie: secCookie, params: { orgId: other.orgId }, body: { offeringId: other.offeringId, startsAt: other.slots[0].startsAt, source: 'phone', patient: { fullName: 'Xis Teste' } } });
    expect(cross.status).toBe(403);
    // AC03: oferta de outra organização na minha organização
    const mix = await call(orgApptsRoute.POST, { cookie: secCookie, params: { orgId: w.orgId }, body: { offeringId: other.offeringId, startsAt: other.slots[0].startsAt, source: 'phone', patient: { fullName: 'Xis Teste' } } });
    expect(mix.status).toBe(404);
    // AC03: paciente de outra organização informado por ID
    const foreignPatient = await one<any>(`INSERT INTO organization_patients(organization_id, full_name, created_via) VALUES ($1,'Alheio','reception') RETURNING id`, [other.orgId]);
    const idor = await call(orgApptsRoute.POST, { cookie: secCookie, params: { orgId: w.orgId }, body: { offeringId: w.offeringId, startsAt: w.slots[6].startsAt, source: 'phone', patient: { fullName: 'Xis Teste', organizationPatientId: foreignPatient.id } } });
    expect(idor.status).toBe(404);
    // AC03: cancelar consulta de outra organização por ID
    const pat = await newUser();
    const foreignAppt = await B.bookAppointment(pat.id, { offeringId: other.offeringId, startsAt: other.slots[1].startsAt, payerType: 'private' });
    const c = await call(cancelRoute.POST, { cookie: secCookie, params: { id: foreignAppt.body.id }, body: {} });
    expect(c.status).toBe(404);
    // listagem restrita ao escopo
    const list = await call(orgApptsRoute.GET, { cookie: secCookie, params: { orgId: w.orgId }, url: `http://localhost/x?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 30 * 86400000).toISOString())}` });
    expect(list.status).toBe(200);
    expect(list.data.every((a: any) => a.practitioner_id === w.pid)).toBe(true);
  });

  it('paciente não vê nem cancela consulta de outro paciente', async () => {
    const w = await makeWorld();
    const p1 = await patientSession(), p2 = await patientSession();
    const a = await B.bookAppointment(p1.user.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await expect(B.getMyAppointment(p2.user.id, a.body.id)).rejects.toMatchObject({ status: 404 });
    const r = await call(cancelRoute.POST, { cookie: p2.cookie, params: { id: a.body.id }, body: {} });
    expect(r.status).toBe(404);
    expect((await B.listMyAppointments(p2.user.id)).length).toBe(0);
  });
});

describe('AC08 — reagendamento atômico', () => {
  it('falha no destino preserva a consulta original', async () => {
    const w = await makeWorld();
    const p1 = await newUser(), p2 = await newUser();
    const a = await B.bookAppointment(p1.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await B.bookAppointment(p2.id, { offeringId: w.offeringId, startsAt: w.slots[1].startsAt, payerType: 'private' });
    await expect(B.rescheduleAppointment(p1.id, a.body.id, { startsAt: w.slots[1].startsAt })).rejects.toMatchObject({ code: 'slot_conflict' });
    const orig = await one<any>('SELECT status, occupancy_id, starts_at FROM appointments WHERE id=$1', [a.body.id]);
    expect(orig.status).toBe('scheduled');
    expect(orig.occupancy_id).toBeTruthy();
    expect(new Date(orig.starts_at).toISOString()).toBe(w.slots[0].startsAt);
    expect(await occCount(w.pid)).toBe(2);
    expect(await count("SELECT count(*) n FROM appointments WHERE rescheduled_from=$1", [a.body.id])).toBe(0);
  });

  it('reagendamento válido troca o vínculo, libera o horário antigo e preserva o snapshot de preço', async () => {
    const w = await makeWorld({ price: 20000 });
    const p = await newUser(), other = await newUser();
    const a = await B.bookAppointment(p.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await upsertOffering(w.org.user.id, w.orgId, { practitionerId: w.pid, locationId: w.locationId, serviceId: w.serviceId, durationMinutes: 30, priceCents: 99900 });
    const r = await B.rescheduleAppointment(p.id, a.body.id, { startsAt: w.slots[2].startsAt });
    expect((await one<any>('SELECT status FROM appointments WHERE id=$1', [a.body.id])).status).toBe('rescheduled');
    const n = await one<any>('SELECT snapshot, rescheduled_from FROM appointments WHERE id=$1', [r.body.id]);
    expect(n.rescheduled_from).toBe(a.body.id);
    expect(n.snapshot.priceCents).toBe(20000); // AC13: contratação anterior preservada
    // horário antigo ficou livre
    await expect(B.bookAppointment(other.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private', expectedPriceCents: 99900 })).resolves.toBeTruthy();
    expect(await occCount(w.pid)).toBe(2);
  });

  it('remarcar para um horário que se sobrepõe ao próprio horário antigo funciona', async () => {
    const w = await makeWorld();
    await upsertOffering(w.org.user.id, w.orgId, { practitionerId: w.pid, locationId: w.locationId, serviceId: w.serviceId, durationMinutes: 60, priceCents: 1000 });
    const o = (await loadOffering(w.offeringId))!;
    const day = await computeSlots(o, w.slots[0].localDate, w.slots[0].localDate);
    const p = await newUser();
    const a = await B.bookAppointment(p.id, { offeringId: w.offeringId, startsAt: day[0].startsAt, payerType: 'private' });
    const r = await B.rescheduleAppointment(p.id, a.body.id, { startsAt: day[1].startsAt });
    expect(r.status).toBe(200);
  });
});

describe('AC12 — reserva temporária', () => {
  it('reserva vencida não bloqueia a agenda mesmo sem worker', async () => {
    const w = await makeWorld();
    const u1 = await newUser(), u2 = await newUser();
    const hold = await B.createHold(u1.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt });
    // enquanto vigente, bloqueia
    await expect(B.createHold(u2.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt })).rejects.toMatchObject({ code: 'slot_conflict' });
    // vence (worker "indisponível": nada roda)
    await query("UPDATE practitioner_occupancies SET expires_at = now() - interval '1 second' WHERE ref_id=$1", [hold.body.holdId]);
    await query("UPDATE slot_holds SET expires_at = now() - interval '1 second' WHERE id=$1", [hold.body.holdId]);
    const o = (await loadOffering(w.offeringId))!;
    const day = await computeSlots(o, w.slots[0].localDate, w.slots[0].localDate);
    expect(day.map((s) => s.startsAt)).toContain(w.slots[0].startsAt); // aparece como livre
    const appt = await B.bookAppointment(u2.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    expect(appt.status).toBe(201);
    // quem tentar confirmar a reserva vencida recebe erro claro
    await expect(B.bookAppointment(u1.id, { holdId: hold.body.holdId, payerType: 'private' })).rejects.toMatchObject({ code: 'hold_expired' });
  });

  it('reserva vigente é confirmada e vira consulta sem abrir janela de dupla ocupação', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const hold = await B.createHold(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt });
    const appt = await B.bookAppointment(u.id, { holdId: hold.body.holdId, payerType: 'private', expectedPriceCents: 25000 });
    expect(appt.status).toBe(201);
    expect(await occCount(w.pid)).toBe(1);
    expect((await one<any>('SELECT status FROM slot_holds WHERE id=$1', [hold.body.holdId])).status).toBe('consumed');
    expect((await one<any>("SELECT kind FROM practitioner_occupancies WHERE practitioner_id=$1", [w.pid])).kind).toBe('appointment');
  });

  it('limpeza por worker remove reservas vencidas', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const h = await B.createHold(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt });
    await query("UPDATE practitioner_occupancies SET expires_at = now() - interval '1 second' WHERE ref_id=$1", [h.body.holdId]);
    expect(await B.sweepExpiredHolds()).toBeGreaterThanOrEqual(1);
    expect(await occCount(w.pid)).toBe(0);
  });
});

describe('idempotência e cancelamento', () => {
  it('mesma chave devolve o mesmo resultado (inclusive em paralelo); corpo diferente é recusado', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const body = { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' as const };
    const [r1, r2, r3] = await Promise.all([B.bookAppointment(u.id, body, 'k-1'), B.bookAppointment(u.id, body, 'k-1'), B.bookAppointment(u.id, body, 'k-1')]);
    expect(r1.body.id).toBe(r2.body.id);
    expect(r1.body.id).toBe(r3.body.id);
    expect(await count("SELECT count(*) n FROM appointments WHERE practitioner_id=$1", [w.pid])).toBe(1);
    await expect(B.bookAppointment(u.id, { ...body, startsAt: w.slots[1].startsAt }, 'k-1')).rejects.toMatchObject({ code: 'idempotency_key_reuse' });
  });

  it('cancelar libera a vaga e repetir o cancelamento não gera eventos duplicados', async () => {
    const w = await makeWorld();
    const u = await newUser(), v = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    const c1 = await B.cancelAppointment(u.id, a.body.id, 'motivo');
    const c2 = await B.cancelAppointment(u.id, a.body.id, 'motivo');
    expect(c1.alreadyCancelled).toBe(false);
    expect(c2.alreadyCancelled).toBe(true);
    expect(await count("SELECT count(*) n FROM appointment_events WHERE appointment_id=$1 AND type='cancelled'", [a.body.id])).toBe(1);
    expect(await count("SELECT count(*) n FROM outbox_events WHERE event_type='AppointmentCancelled' AND payload->>'appointmentId'=$1", [a.body.id])).toBe(1);
    await expect(B.bookAppointment(v.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' })).resolves.toBeTruthy();
  });

  it('via API: paciente cancela pelo app sem ligação', async () => {
    const w = await makeWorld();
    const p = await patientSession();
    const b = await call(apptsRoute.POST, { cookie: p.cookie, headers: { 'idempotency-key': 'abc-' + rnd() }, body: { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' } });
    expect(b.status).toBe(201);
    const c = await call(cancelRoute.POST, { cookie: p.cookie, params: { id: b.data.id }, body: {} });
    expect(c.status).toBe(200);
    expect(c.data.status).toBe('cancelled');
  });
});

describe('AC09 — lembretes e cancelamento concorrentes', () => {
  it('job revalida o estado imediatamente antes do envio', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await processOutbox();
    const jobs = await query("SELECT template_key FROM notification_jobs WHERE appointment_id=$1 ORDER BY template_key", [a.body.id]);
    expect(jobs.map((j) => j.template_key)).toEqual(['appointment_reminder', 'appointment_reminder', 'appointment_scheduled']);
    // força o lembrete a vencer e, EM PARALELO, cancela
    await query("UPDATE notification_jobs SET send_at = now() - interval '1 minute' WHERE appointment_id=$1 AND template_key='appointment_reminder'", [a.body.id]);
    await Promise.all([B.cancelAppointment(u.id, a.body.id), processDueJobs(50)]);
    await processOutbox();
    await processDueJobs(50);
    const sentReminders = await count("SELECT count(*) n FROM notification_jobs j WHERE j.appointment_id=$1 AND template_key='appointment_reminder' AND status='sent'", [a.body.id]);
    const mailsAfterCancel = await query("SELECT body FROM dev_mailbox WHERE to_email=$1 AND body LIKE '%Confirmar presença%'", [(await one<any>('SELECT email FROM users WHERE id=$1', [u.id])).email]);
    // ou o lembrete saiu ANTES do cancelamento (corrida legítima), ou foi pulado; nunca depois de cancelado
    const cancelledAt = (await one<any>('SELECT cancelled_at FROM appointments WHERE id=$1', [a.body.id])).cancelled_at;
    const late = await count("SELECT count(*) n FROM notification_jobs WHERE appointment_id=$1 AND template_key='appointment_reminder' AND status='sent' AND sent_at > $2", [a.body.id, cancelledAt]);
    expect(late).toBe(0);
    expect(sentReminders + (await count("SELECT count(*) n FROM notification_jobs WHERE appointment_id=$1 AND template_key='appointment_reminder' AND status='skipped'", [a.body.id]))).toBe(2);
    expect(mailsAfterCancel.length).toBe(sentReminders);
  });

  it('cancelado antes do envio: lembrete é pulado; aviso de cancelamento é discreto', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await processOutbox();
    await B.cancelAppointment(u.id, a.body.id);
    await query("UPDATE notification_jobs SET send_at = now() - interval '1 minute' WHERE appointment_id=$1 AND status='pending'", [a.body.id]);
    await processOutbox();
    await processDueJobs(50);
    expect(await count("SELECT count(*) n FROM notification_jobs WHERE appointment_id=$1 AND template_key='appointment_reminder' AND status='sent'", [a.body.id])).toBe(0);
    const email = (await one<any>('SELECT email FROM users WHERE id=$1', [u.id])).email;
    const mails = await query('SELECT subject, body FROM dev_mailbox WHERE to_email=$1', [email]);
    const all = JSON.stringify(mails);
    expect(all).not.toMatch(/Cardiolog|Dr\(a\)|Silva|Rua das Flores|R\$|consulta com/i); // sem especialidade, médico, endereço, valor
  });

  it('consulta marcada em cima da hora não gera lembrete já vencido', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    // antecipa a consulta para daqui a 5h (bypass de teste) e reprocessa a fila em um novo evento
    await query("UPDATE appointments SET starts_at = now() + interval '5 hours', ends_at = now() + interval '330 minutes' WHERE id=$1", [a.body.id]);
    await query('DELETE FROM notification_jobs WHERE appointment_id=$1', [a.body.id]);
    await query("INSERT INTO outbox_events(event_type, payload, dedupe_key) VALUES ('AppointmentScheduled', $1, $2)", [JSON.stringify({ appointmentId: a.body.id, version: 1 }), 'again-' + rnd()]);
    await processOutbox();
    const jobs = await query("SELECT dedupe_key FROM notification_jobs WHERE appointment_id=$1 AND template_key='appointment_reminder'", [a.body.id]);
    expect(jobs.length).toBe(1); // o de 24h já venceu e não é criado; só o de 3h antes
  });

  it('e-mail falho não é dado como enviado (produção sem provedor falha fechado)', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await processOutbox();
    const prev = process.env.EMAIL_MODE;
    process.env.EMAIL_MODE = 'none';
    try {
      await processDueJobs(50);
    } finally { process.env.EMAIL_MODE = prev; }
    const j = await one<any>("SELECT status, attempts, last_error FROM notification_jobs WHERE appointment_id=$1 AND template_key='appointment_scheduled'", [a.body.id]);
    expect(j.status).toBe('pending');
    expect(j.attempts).toBe(1);
    expect(j.last_error).toBe('email_provider_not_configured');
  });
});

describe('AC13 — preço e snapshot', () => {
  it('preço alterado depois da marcação não altera a contratação; divergência na tela bloqueia a confirmação', async () => {
    const w = await makeWorld({ price: 20000 });
    const u = await newUser();
    await upsertOffering(w.org.user.id, w.orgId, { practitionerId: w.pid, locationId: w.locationId, serviceId: w.serviceId, durationMinutes: 30, priceCents: 30000 });
    await expect(B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private', expectedPriceCents: 20000 })).rejects.toMatchObject({ code: 'price_changed' });
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private', expectedPriceCents: 30000 });
    await upsertOffering(w.org.user.id, w.orgId, { practitionerId: w.pid, locationId: w.locationId, serviceId: w.serviceId, durationMinutes: 30, priceCents: 45000 });
    const view = await B.getMyAppointment(u.id, a.body.id);
    expect((view.snapshot as any).priceCents).toBe(30000);
    expect((view.snapshot as any).location.address).toContain('Rua das Flores');
    expect((view.snapshot as any).documents.terms.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((view.snapshot as any).paymentAt).toBe('no local');
  });

  it('preço não informado é registrado como não informado, nunca R$ 0', async () => {
    const w = await makeWorld({ price: null });
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    const v = await B.getMyAppointment(u.id, a.body.id);
    expect((v.snapshot as any).priceCents).toBeNull();
    expect((v.snapshot as any).priceInformed).toBe(false);
  });
});

describe('convênio, presença e conclusão', () => {
  it('convênio que exige autorização fica pendente (ocupa a vaga) até aprovação; não anuncia confirmação', async () => {
    const w = await makeWorld();
    const prod = await addInsurance(w, true);
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'insurance', insuranceProductId: prod });
    expect((await one<any>('SELECT status FROM appointments WHERE id=$1', [a.body.id])).status).toBe('pending_approval');
    await processOutbox();
    expect(await count("SELECT count(*) n FROM notification_jobs WHERE appointment_id=$1", [a.body.id])).toBe(0);
    expect(await occCount(w.pid)).toBe(1);
    await B.approvePending(w.org.user.id, a.body.id, true);
    await processOutbox();
    expect(await count("SELECT count(*) n FROM notification_jobs WHERE appointment_id=$1", [a.body.id])).toBeGreaterThan(0);
    // produto não aceito
    await expect(B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[1].startsAt, payerType: 'insurance', insuranceProductId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'insurance_not_accepted' });
  });

  it('conclusão/falta só depois do horário, só pela equipe autorizada; paciente contesta', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    await expect(B.closeAppointment(w.org.user.id, a.body.id, 'completed')).rejects.toMatchObject({ code: 'too_early' });
    await expect(B.closeAppointment(u.id, a.body.id, 'completed')).rejects.toMatchObject({ status: 403 }); // paciente não é equipe
    await B.confirmAttendance(u.id, a.body.id);
    await query("UPDATE appointments SET starts_at = now() - interval '2 hours', ends_at = now() - interval '90 minutes' WHERE id=$1", [a.body.id]);
    await expect(B.closeAppointment(w.org.user.id, a.body.id, 'no_show')).resolves.toMatchObject({ attendance: 'no_show' });
    const t = await B.contestNoShow(u.id, a.body.id, 'Eu compareci ao horário');
    expect(t.protocol).toMatch(/^CT-/);
    const ev = await query('SELECT type FROM appointment_events WHERE appointment_id=$1 ORDER BY id', [a.body.id]);
    expect(ev.map((e) => e.type)).toEqual(['created', 'attendance_confirmed', 'no_show', 'no_show_contested']);
  });
});

describe('impacto de alterações de agenda (regra 10)', () => {
  it('bloqueio sobre consulta existente é recusado com a lista de impactadas', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    const start = new Date(new Date(w.slots[0].startsAt).getTime() - 3600_000).toISOString();
    const end = new Date(new Date(w.slots[0].startsAt).getTime() + 3600_000).toISOString();
    await expect(createBlock(w.org.user.id, w.orgId, { practitionerId: w.pid, startsAt: start, endsAt: end })).rejects.toMatchObject({ code: 'block_impacts_appointments', details: { impactedAppointmentIds: [a.body.id] } });
    await B.cancelAppointment(u.id, a.body.id);
    await expect(createBlock(w.org.user.id, w.orgId, { practitionerId: w.pid, startsAt: start, endsAt: end })).resolves.toBeTruthy();
    const o = (await loadOffering(w.offeringId))!;
    const day = await computeSlots(o, w.slots[0].localDate, w.slots[0].localDate);
    expect(day.map((s) => s.startsAt)).not.toContain(w.slots[0].startsAt);
  });

  it('desativar regra que afeta consultas exige reconhecimento explícito; consultas são preservadas e sinalizadas', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    const rules = await listRules(w.org.user.id, w.orgId, w.pid);
    const wd = DateTime.fromISO(w.slots[0].localDate).weekday;
    const rule = rules.find((r: any) => r.weekday === wd)!;
    await expect(deactivateRule(w.org.user.id, w.orgId, rule.id, [])).rejects.toMatchObject({ code: 'schedule_change_impacts_appointments', details: { impactedAppointmentIds: [a.body.id] } });
    expect((await one<any>('SELECT active FROM availability_rules WHERE id=$1', [rule.id])).active).toBe(true); // nada aplicado
    const r = await deactivateRule(w.org.user.id, w.orgId, rule.id, [a.body.id]);
    expect(r.impactedAppointmentIds).toEqual([a.body.id]);
    const ap = await one<any>('SELECT status, needs_followup FROM appointments WHERE id=$1', [a.body.id]);
    expect(ap.status).toBe('scheduled');
    expect(ap.needs_followup).toBe(true);
  });

  it('exceção de data prevalece sobre a recorrência (feriado fecha o dia; janela especial substitui)', async () => {
    const w = await makeWorld();
    const { createException } = await import('../src/server/modules/availability');
    const d = w.slots[0].localDate;
    await createException(w.org.user.id, w.orgId, { practitionerId: w.pid, locationId: w.locationId, onDate: d, kind: 'closed' });
    const o = (await loadOffering(w.offeringId))!;
    expect((await computeSlots(o, d, d)).length).toBe(0);
    const d2 = w.slots.find((s) => s.localDate !== d)!.localDate;
    await createException(w.org.user.id, w.orgId, { practitionerId: w.pid, locationId: w.locationId, onDate: d2, kind: 'open', startTime: '14:00', endTime: '15:00' });
    expect((await computeSlots(o, d2, d2)).map((s) => s.localTime)).toEqual(['14:00', '14:15', '14:30']);
  });
});

describe('fuso horário', () => {
  it('horário local é convertido corretamente para UTC por local', async () => {
    const sp = await makeWorld({ timezone: 'America/Sao_Paulo' });
    const mn = await makeWorld({ timezone: 'America/Manaus' });
    const s1 = sp.slots.find((s) => s.localTime === '08:00')!;
    const s2 = mn.slots.find((s) => s.localTime === '08:00')!;
    expect(new Date(s1.startsAt).getUTCHours()).toBe(11); // UTC-3
    expect(new Date(s2.startsAt).getUTCHours()).toBe(12); // UTC-4
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: mn.offeringId, startsAt: s2.startsAt, payerType: 'private' });
    expect((await B.getMyAppointment(u.id, a.body.id)).timezone).toBe('America/Manaus');
  });
});

describe('AC16 — links assinados', () => {
  it('GET nunca altera estado; só POST com token da finalidade correta executa', async () => {
    const w = await makeWorld();
    const u = await newUser();
    const a = await B.bookAppointment(u.id, { offeringId: w.offeringId, startsAt: w.slots[0].startsAt, payerType: 'private' });
    const cancelTok = signLink('appt_cancel', a.body.id, 3600);
    const confirmTok = signLink('appt_confirm', a.body.id, 3600);
    const g = await call(linkRoute.GET, { params: { token: cancelTok } }); // como um scanner de e-mail faria
    expect(g.status).toBe(200);
    expect(g.data.action).toBe('cancel');
    expect((await one<any>('SELECT status FROM appointments WHERE id=$1', [a.body.id])).status).toBe('scheduled');
    expect(await count("SELECT count(*) n FROM appointment_events WHERE appointment_id=$1", [a.body.id])).toBe(1);
    // token de confirmar não serve para cancelar
    expect((await call(linkAct.POST, { body: { token: confirmTok, action: 'cancel' } })).status).toBe(404);
    // expirado
    expect((await call(linkAct.POST, { body: { token: signLink('appt_cancel', a.body.id, -10), action: 'cancel' } })).status).toBe(404);
    const c = await call(linkAct.POST, { body: { token: confirmTok, action: 'confirm' } });
    expect(c.status).toBe(200);
    expect((await one<any>('SELECT attendance FROM appointments WHERE id=$1', [a.body.id])).attendance).toBe('confirmed');
    const x = await call(linkAct.POST, { body: { token: cancelTok, action: 'cancel' } });
    expect(x.status).toBe(200);
    expect((await one<any>('SELECT status FROM appointments WHERE id=$1', [a.body.id])).status).toBe('cancelled');
    expect((await call(linkRoute.GET, { params: { token: 'lixo' } })).status).toBe(404);
  });
});

describe('AC17 — módulos bloqueados', () => {
  it('benefícios, pagamento clínico, telemedicina, dependentes, exames e avaliações públicas respondem 403 na API', async () => {
    const p = await patientSession();
    for (const r of [loyaltyRoute, clinicalPay, tele, deps, exams, reviews]) {
      for (const m of ['GET', 'POST'] as const) {
        const res = await call((r as any)[m], { method: m, cookie: p.cookie, body: m === 'POST' ? {} : undefined });
        expect(res.status).toBe(403);
        expect(res.data.error.code).toBe('feature_disabled');
      }
    }
  });

  it('flag regulada não liga sem aprovação registrada; sem implementação, mesmo aprovada não executa', async () => {
    await expect(pool().query("UPDATE feature_flags SET enabled=true WHERE key='loyalty_points'")).rejects.toThrow(/check constraint/i);
    const { isEnabled, approveAndEnableFlag } = await import('../src/server/modules/flags');
    expect(await isEnabled('loyalty_points')).toBe(false);
    expect(await isEnabled('chave_inexistente')).toBe(false);
    await expect(approveAndEnableFlag('00000000-0000-4000-8000-000000000000', {
      key: 'loyalty_points', decisionRef: 'x', scope: 'x', approvedBy: 'x', approvedAt: '2026-01-01', reviewBy: '2027-01-01',
    })).rejects.toMatchObject({ code: 'not_implemented' });
    const flags = await query('SELECT key, enabled FROM feature_flags');
    expect(flags.every((f) => f.enabled === false)).toBe(true);
  });
});

describe('AC15 — recusa de marketing/geolocalização', () => {
  it('busca manual e agendamento funcionam sem localização nem marketing', async () => {
    const w = await makeWorld({ city: 'Cidade Manual ' + rnd() });
    const u = await newUser();
    await query("INSERT INTO consent_events(user_id, purpose, granted) VALUES ($1,'marketing',false),($1,'geolocation',false)", [u.id]);
    const { searchPractitioners } = await import('../src/server/modules/search');
    const city = (await one<any>('SELECT city FROM locations WHERE id=$1', [w.locationId])).city;
    const r = await searchPractitioners({ city });
    expect(r.total).toBe(1);
    expect(r.items[0].distanceKm).toBeNull();
    const a = await B.bookAppointment(u.id, { offeringId: r.items[0].services[0].offeringId, startsAt: r.items[0].nextSlot!.startsAt, payerType: 'private' });
    expect(a.status).toBe(201);
    expect(lastMailCode).toBeTruthy();
  });
});
