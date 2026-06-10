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
  // Anchor to the FILENAME (after a path separator) — an unanchored /preview-…/
  // also matches a parent dir named like a worktree (…/civitai-preview-x/), which
  // would wrongly pull in the non-preview specs (auction/generation/example).
  testMatch: /(^|\/)preview-.*\.(setup|spec)\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Run SERIALLY. The preview is a single-replica, cold, resource-modest pod.
  // Concurrent loads of the heavy pages (/models, /images, /purchase/buzz,
  // /pricing, model detail) across multiple workers segfaulted it (exit 139),
  // which cascaded fast failures into unrelated tests. One page at a time lets
  // the pod cope; the suite is small + report-only, so serial (~2-3 min) is fine.
  workers: 1,
  // A freshly-deployed preview is cold: the first SSR render of a heavy page (the
  // homepage especially) can take 30-40s while the Next server warms, JIT-compiles,
  // and opens DB pools. The default 30s per-test timeout is too tight for that cold
  // first hit, so raise both the per-test and navigation timeouts. The setup project
  // also fires a warm-up request before the suite (preview-auth.setup.ts).
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: PREVIEW_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'preview-setup', testMatch: /(^|\/)preview-auth\.setup\.ts$/ },
    {
      name: 'preview-smoke',
      testMatch: /(^|\/)preview-.*\.spec\.ts$/,
      dependencies: ['preview-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
