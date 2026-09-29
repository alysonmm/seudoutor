import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { generateSync } from 'otplib';
import { Client } from 'pg';

const DB = 'postgres://seudoutor:seudoutor@localhost:5432/seudoutor_dev';
const PASSWORD = 'Senha-Seed-123!';
const MFA = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function mailCode(email: string) {
  const c = new Client({ connectionString: DB }); await c.connect();
  try {
    for (let i = 0; i < 20; i++) {
      const r = await c.query("SELECT body FROM dev_mailbox WHERE to_email=$1 AND body LIKE '%código é%' ORDER BY id DESC LIMIT 1", [email]);
      const m = r.rows[0]?.body.match(/código é (\d{6})/);
      if (m) return m[1] as string;
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally { await c.end(); }
  throw new Error('sem código');
}
async function loginStaff(page: Page, email: string, next = '/painel') {
  await page.goto('/entrar?next=' + encodeURIComponent(next));
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Segundo fator de autenticação' })).toBeVisible();
  // evita replay do mesmo passo TOTP entre testes
  const c = new Client({ connectionString: DB }); await c.connect(); await c.query('UPDATE mfa_methods SET last_used_step=NULL'); await c.end();
  await page.getByLabel(/Código do aplicativo/).fill(generateSync({ secret: MFA }));
  await page.getByRole('button', { name: 'Verificar' }).click();
  await page.waitForURL(new RegExp(next));
}
async function noSeriousA11y(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${label}: ${v.id} (${v.nodes.length})`), JSON.stringify(bad.map((v) => v.nodes[0]?.html))).toEqual([]);
}

test('páginas públicas: sem violações sérias de acessibilidade e com skip link por teclado', async ({ page }) => {
  for (const url of ['/', '/buscar?city=Cidade%20Exemplo', '/entrar', '/cadastro', '/planos', '/termos', '/acessibilidade']) {
    await page.goto(url);
    await noSeriousA11y(page, url);
  }
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ir para o conteúdo' })).toBeFocused();
});

test('paciente: cadastro → busca → agendamento → cancelamento (fluxo completo na interface)', async ({ page }) => {
  const email = `e2e${Date.now()}@example.test`;
  await page.goto('/cadastro');
  await page.getByLabel('Nome completo').fill('Paciente E2E Sintético');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: false }).first().fill(PASSWORD);
  await page.getByLabel(/Li e aceito os Termos/).check();
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await page.waitForURL(/verificar-contato/);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Código').fill(await mailCode(email));
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await page.waitForURL(/entrar/);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/app/);

  await page.goto('/buscar');
  await page.getByLabel('Cidade').fill('Cidade Exemplo');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Dra. Sintética Exemplo' })).toBeVisible();
  await noSeriousA11y(page, 'resultados');
  await page.getByRole('link', { name: 'Dra. Sintética Exemplo' }).click();
  await expect(page.getByText(/registro verificado em/)).toBeVisible();
  await noSeriousA11y(page, 'perfil');

  const firstSlot = page.getByRole('group').first().getByRole('button').first();
  await firstSlot.click();
  await expect(page.getByRole('heading', { name: 'Revise antes de confirmar' })).toBeVisible();
  await expect(page.getByText(/pagamento no local|Particular/).first()).toBeVisible();
  const confirmBtn = page.getByRole('button', { name: 'Confirmar agendamento' });
  await expect(confirmBtn).toBeDisabled(); // exige aceite explícito
  await page.getByLabel(/Li as condições/).check();
  await confirmBtn.click();
  await expect(page.getByText('Agendamento confirmado')).toBeVisible();
  await page.getByRole('link', { name: 'Ver agendamento' }).click();
  await expect(page.getByRole('heading', { name: 'Agendamento', exact: true })).toBeVisible();
  await noSeriousA11y(page, 'detalhe do agendamento');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancelar agendamento' }).click();
  await page.waitForURL(/agendamentos$/);
  await expect(page.getByText('Cancelado').first()).toBeVisible();

  // logout limpa a sessão: área privada exige nova autenticação
  await page.getByRole('button', { name: 'Sair' }).click();
  await page.waitForURL('http://localhost:3100/');
  await page.goto('/app');
  await expect(page).toHaveURL(/entrar/);
});

test('médica: login com segundo fator → painel e agenda; paciente não acessa painel/admin', async ({ page }) => {
  await loginStaff(page, 'medica.seed@example.test', '/painel');
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
  await noSeriousA11y(page, 'painel');
  await page.goto('/painel/agenda');
  await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible();
  await page.goto('/painel/assinatura');
  await expect(page.getByText(/Em teste gratuito/)).toBeVisible();
  await page.goto('/admin');
  await expect(page).not.toHaveURL(/\/admin$/); // sem papel de plataforma: redirecionada
});

test('administração: credenciamento e auditoria acessíveis com MFA', async ({ page }) => {
  await loginStaff(page, 'admin.seed@example.test', '/admin');
  await expect(page.getByRole('heading', { name: 'Administração' })).toBeVisible();
  await page.goto('/admin/credenciamento');
  await expect(page.getByRole('heading', { name: 'Credenciamento' })).toBeVisible();
  await page.goto('/admin/configuracoes');
  await expect(page.getByText('loyalty_points')).toBeVisible();
  await noSeriousA11y(page, 'admin configurações');
});

test('rede: falha na confirmação não é apresentada como sucesso', async ({ page, context }) => {
  const email = 'paciente.seed@example.test';
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(email); await page.getByLabel('Senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/app/);
  await page.goto('/buscar?city=Cidade%20Exemplo');
  await page.getByRole('link', { name: 'Dra. Sintética Exemplo' }).click();
  await page.getByRole('group').first().getByRole('button').first().click();
  await page.getByLabel(/Li as condições/).check();
  await context.route('**/api/v1/appointments', (r) => r.abort());
  await page.getByRole('button', { name: 'Confirmar agendamento' }).click();
  await expect(page.getByText(/Falha de rede/)).toBeVisible();
  await expect(page.getByText('Agendamento confirmado')).toHaveCount(0);
});
