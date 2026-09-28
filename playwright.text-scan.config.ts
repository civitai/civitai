import { defineConfig, devices } from '@playwright/test';
import { e2eEnv } from './tests/text-scan/env';

const env = e2eEnv();

export default defineConfig({
  testDir: './tests/text-scan',
  testMatch: /(^|\/)[^/]+\.spec\.ts$/,
  globalSetup: './tests/text-scan/global-setup.ts',
  fullyParallel: false,
  workers: 3,
  retries: 0,
  forbidOnly: true,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: env.TEXT_SCAN_E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 180_000,
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: `text-scan-${env.TEXT_SCAN_E2E_PHASE}`,
      grep: new RegExp(`@${env.TEXT_SCAN_E2E_PHASE}\\b`),
    },
  ],
});
