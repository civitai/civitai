import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for smoke-testing a DEPLOYED Civitai auth hub (auth.civitai.com,
 * or a hub PR preview). The hub analog of the main app's playwright.preview.config.ts.
 *
 * Unlike the main app's playwright.config.ts there is NO `webServer` — we hit the live
 * hub at HUB_URL. Auth is minted out-of-band by hub-auth.setup.ts (the hub's
 * `/api/auth/dev/login` is double-gated to `vite dev`, so it is dead against a
 * production build; we mint the session JWS directly with @civitai/auth's signer).
 *
 * Requires env: HUB_URL (e.g. https://auth.civitai.com or https://hub-pr-N....).
 * Optional env (only for the authenticated identity assertions — see README):
 *   AUTH_JWT_PRIVATE_KEY / AUTH_JWT_KID / AUTH_JWT_ISSUER — a keypair the hub TRUSTS.
 *   If unset, the setup generates an ephemeral TEST keypair; identity/JWKS-trust
 *   assertions are then skipped (the hub won't verify a key it doesn't know).
 *
 * Run:
 *   HUB_URL=https://auth.civitai.com \
 *     corepack pnpm --filter @civitai/auth-app exec \
 *     playwright test -c e2e/playwright.hub.config.ts
 *
 * SCAFFOLD — not yet wired to a live hub preview. See e2e/README.md.
 */

const HUB_URL = process.env.HUB_URL;
if (!HUB_URL) {
  throw new Error(
    'HUB_URL is required for e2e/playwright.hub.config.ts (e.g. https://auth.civitai.com). ' +
      'This harness targets a DEPLOYED hub — there is no local webServer.'
  );
}

export default defineConfig({
  testDir: '.',
  // Anchor to the FILENAME (after a path separator) so a parent dir named like a
  // worktree can't pull in unrelated specs. Only this harness's hub-* files match.
  testMatch: /(^|\/)hub-.*\.(setup|spec)\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A freshly-deployed hub preview is cold; a transient CPU-throttle window on a
  // contended node can flake a single request. One retry under CI lets it recover.
  retries: process.env.CI ? 1 : 0,
  // Run SERIALLY (single worker). The hub preview is a single-replica, cold,
  // resource-modest pod; concurrent loads add no value for this tiny smoke suite.
  workers: 1,
  // A cold hub pod's first SSR render (/login) + JWKS import can take longer than the
  // default 30s. 60s per-test with a matching nav budget gives the cold first hit room.
  timeout: 60_000,
  // Report-only: no JUnit/CI-gating output. List + HTML for human inspection.
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: HUB_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'hub-setup', testMatch: /(^|\/)hub-auth\.setup\.ts$/ },
    {
      name: 'hub-smoke',
      testMatch: /(^|\/)hub-.*\.spec\.ts$/,
      dependencies: ['hub-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
