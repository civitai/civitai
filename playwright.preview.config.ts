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
  // 2 retries (was 1): the preview pod can hit a transient CPU-throttle window on a
  // contended node; with pre-warm (preview-auth.setup.ts) covering cold-start, the
  // residual flake is a mid-run slow window. A 2nd retry gives it another recovery
  // chance so a slow window flakes-and-recovers instead of surfacing as a failure.
  retries: process.env.CI ? 2 : 0,
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
  // 90s (was 60s): on a contended preview node the single-replica pod gets CPU-
  // throttled and the heaviest SSR pages (/user/membership, /models) intermittently
  // crossed the 60s ceiling (observed ~66s) — a slow window should flake-and-recover
  // on retry, not hard-fail. 90s gives comfortable margin without masking a real hang.
  timeout: 90_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: PREVIEW_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Align with the per-test timeout: a cold heavy-page (/models) goto can need
    // most of the budget, and a tighter nav cap would fail it even though the test
    // has 90s. The setup project also pre-warms /models + /images authenticated.
    navigationTimeout: 90_000,
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
