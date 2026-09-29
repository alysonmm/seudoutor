import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', launchOptions: exe ? { executablePath: exe } : {} },
  webServer: {
    command: 'npx next dev -p 3100',
    url: 'http://localhost:3100/planos',
    reuseExistingServer: true,
    timeout: 60_000,
    env: { DATABASE_URL: 'postgres://seudoutor:seudoutor@localhost:5432/seudoutor_dev', APP_BASE_URL: 'http://localhost:3100' },
  },
});
