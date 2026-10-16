import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, E2E_PORT } from './e2e/fixtures.ts';

// A local HTTP proxy (e.g. Clash on 127.0.0.1:7890) must not intercept the test server.
process.env.NO_PROXY = process.env.no_proxy = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx tsx e2e/serve.ts',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
