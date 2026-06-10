import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for smoke-testing a DEPLOYED PR preview environment.
 *
 * Used by the datapacket-talos `pr-smoke-test` Tekton task, not local dev. Unlike
 * playwright.config.ts there is no `webServer` — we hit the live preview at
 * PREVIEW_URL (e.g. https://pr-1234.civitaic.com). Auth is minted by
 * tests/preview-auth.setup.ts (no /testing/testing-login, which is dead under a
 * production build). Requires env: PREVIEW_URL, NEXTAUTH_SECRET.
 *
 * Run: PREVIEW_URL=… NEXTAUTH_SECRET=… npx playwright test -c playwright.preview.config.ts
 */

const PREVIEW_URL = process.env.PREVIEW_URL;
if (!PREVIEW_URL) {
  throw new Error('PREVIEW_URL is required for playwright.preview.config.ts');
}

export default defineConfig({
  testDir: './tests',
  testMatch: /preview-(auth\.setup|smoke\.spec)\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: PREVIEW_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'preview-setup', testMatch: /preview-auth\.setup\.ts/ },
    {
      name: 'preview-smoke',
      testMatch: /preview-smoke\.spec\.ts/,
      dependencies: ['preview-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
