/**
 * Seed SINTÉTICO e repetível — apenas dev/homologação. Recusa rodar em produção.
 * Todos os nomes, CRMs e e-mails são fictícios (domínio .test). Não representa pessoas reais.
 */
import fs from 'node:fs';
if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
import { generateSync } from 'otplib';
import { one, query, pool, closePool } from '../src/server/db';
import { config } from '../src/server/config';
import { register } from '../src/server/modules/identity';
import { seedLegalDrafts } from '../src/server/seed/legal';
import { encrypt, sha256 } from '../src/server/lib/crypto';

export const SEED_PASSWORD = 'Senha-Seed-123!';
export const SEED_MFA_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function user(email: string, name: string) {
  let u = await one<{ id: string }>('SELECT id FROM users WHERE email=$1', [email]);
  if (!u) {
    await register({ email, password: SEED_PASSWORD, fullName: name, acceptTerms: true, ip: 'seed-' + Math.random() });
    u = await one<{ id: string }>('SELECT id FROM users WHERE email=$1', [email]);
  }
  await query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id=$1', [u!.id]);
  return u!.id;
}
async function withMfa(userId: string) {
  await query('DELETE FROM mfa_methods WHERE user_id=$1', [userId]);
  await query('INSERT INTO mfa_methods(user_id, secret_enc, confirmed_at) VALUES ($1,$2,now())', [userId, encrypt(SEED_MFA_SECRET)]);
}

export async function seed() {
  if (config.isProd) throw new Error('Seed sintético não roda em produção');
  await seedLegalDrafts();
  const { createOrganization } = await import('../src/server/modules/orgs');
  const { saveIdentity, submitForReview, reviewVersion } = await import('../src/server/modules/credentialing');
  const { createLocation, createService, upsertOffering, setAcceptedInsurance } = await import('../src/server/modules/catalog');
  const { createRule } = await import('../src/server/modules/availability');
  const city = process.env.PILOT_CITY || 'Cidade Exemplo';

  const adminId = await user('admin.seed@example.test', 'Admin Sintético');
  for (const r of ['moderator', 'platform_admin', 'security_admin', 'support']) await query('INSERT INTO platform_staff(user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [adminId, r]);
  await withMfa(adminId);
  await user('paciente.seed@example.test', 'Paciente Sintético');

  const docId = await user('medica.seed@example.test', 'Dra. Sintética Exemplo');
  let org = await one<{ id: string }>("SELECT o.id FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 LIMIT 1", [docId]);
  if (!org) {
    const c = await createOrganization(docId, { kind: 'individual', name: 'Consultório Exemplo (sintético)', asPractitioner: true, acceptContract: true });
    org = { id: c.organizationId };
    const pid = c.practitionerId!;
    const spec = await one<{ id: string }>("SELECT id FROM specialties WHERE slug='clinica-medica'");
    await saveIdentity(docId, org.id, pid, { displayName: 'Dra. Sintética Exemplo', registrations: [{ uf: 'SP', number: '999001' }], specialties: [{ specialtyId: spec!.id }] });
    const { versionId } = await submitForReview(docId, org.id, pid);
    await reviewVersion(adminId, versionId, { decision: 'approve', evidence: { source: 'DADO SINTÉTICO — nenhuma verificação real foi feita', registration: 'CRM/SP 999001 (fictício)', situation: 'sintético', checkedAt: new Date().toISOString().slice(0, 10), nextReviewAt: '2099-01-01' } });
    const loc = await createLocation(docId, org.id, { name: 'Sede', street: 'Rua Exemplo', number: '100', neighborhood: 'Centro', city, uf: 'SP', latitude: -23.55, longitude: -46.63, timezone: 'America/Sao_Paulo', accessibility: ['rampa'] });
    const svc = await createService(docId, org.id, 'Consulta');
    const off = await upsertOffering(docId, org.id, { practitionerId: pid, locationId: loc.id, serviceId: svc.id, durationMinutes: 30, priceCents: 25000, paymentMethods: ['pix', 'cartão'] });
    for (let wd = 1; wd <= 5; wd++) await createRule(docId, org.id, { practitionerId: pid, locationId: loc.id, weekday: wd, startTime: '08:00', endTime: '12:00', slotStepMinutes: 30 });
    const ins = await one<{ id: string }>("INSERT INTO insurers(name) VALUES ('Operadora Exemplo') ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id");
    const prod = await one<{ id: string }>("INSERT INTO insurance_products(insurer_id, name) VALUES ($1,'Produto Exemplo') ON CONFLICT (insurer_id, name) DO UPDATE SET name=EXCLUDED.name RETURNING id", [ins!.id]);
    await setAcceptedInsurance(docId, org.id, off.id, [{ insuranceProductId: prod!.id, requiresAuthorization: false }]);
    const pv = await one<{ id: string }>("SELECT id FROM plan_versions WHERE plan_id='profissional' ORDER BY version DESC LIMIT 1");
    await query(`INSERT INTO subscriptions(organization_id, plan_version_id, billing_period, status, trial_ends_at, amount_cents) VALUES ($1,$2,'monthly','trialing', now() + interval '365 days', 12900)`, [org.id, pv!.id]);
  }
  await withMfa(docId);
  return { adminEmail: 'admin.seed@example.test', doctorEmail: 'medica.seed@example.test', patientEmail: 'paciente.seed@example.test', password: SEED_PASSWORD, mfaSecret: SEED_MFA_SECRET, city, sampleTotp: generateSync({ secret: SEED_MFA_SECRET }), sha: sha256('x').slice(0, 1) };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seed().then((r) => { console.log('Seed sintético concluído:\n', { ...r, sha: undefined }); return closePool(); }).catch((e) => { console.error(e.message); process.exit(1); });
}
export { pool };
