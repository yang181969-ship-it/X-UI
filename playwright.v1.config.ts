import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, E2E_V1_PORT } from './e2e-v1/fixtures.ts';

// X-UI v1 browser tests (npm run test:e2e:v1); the legacy suite keeps playwright.config.ts.
// A local HTTP proxy (e.g. Clash on 127.0.0.1:7890) must not intercept the test server.
process.env.NO_PROXY = process.env.no_proxy = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',');

export default defineConfig({
  testDir: './e2e-v1',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './test-results/e2e-v1',
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build:v1 && npx tsx e2e-v1/serve.ts',
    url: `http://127.0.0.1:${E2E_V1_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
