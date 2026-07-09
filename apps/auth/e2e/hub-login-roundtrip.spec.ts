import { test, expect, type Page } from '@playwright/test';

/**
 * Hub login ROUND-TRIP (Phase 3b) — the full Authorization-Code + PKCE flow end-to-end against a real
 * upstream, using the deterministic `stub` provider (apps/auth/e2e/stub-oidc-server.mjs deployed as the hub's
 * upstream; the hub's env-gated `stub` provider points its authorize/token/userinfo URLs at it):
 *
 *   GET /login/stub  → 302 to the stub /authorize  → (stub auto-approves) 302 to /login/stub/callback?code=…
 *   → hub exchanges code (token + userinfo via the stub) → findOrCreateUser → establishSession (civ-token)
 *   → authenticated.
 *
 * This is the one path the other hub specs can't cover (hub-login only inspects the START redirect; hub-smoke
 * uses a MINTED cookie, skipping the real OAuth exchange). It needs the stub deployed + the hub configured with
 * AUTH_ENABLE_STUB_PROVIDER — so it SKIPS cleanly on a hub that doesn't advertise `stub` (e.g. before Stage 2),
 * keeping the report-only auth-hub-e2e CronJob green until the stub upstream is live.
 */

// The stub provider only appears in /login when the hub has AUTH_ENABLE_STUB_PROVIDER + STUB_* set. Discover it
// the same host-agnostic way hub-login.spec discovers OAuth providers (scan the rendered /login), so this spec
// activates automatically once Stage 2 wires the stub and skips otherwise.
async function stubProviderAvailable(page: Page): Promise<boolean> {
  await page.goto('/login');
  const body = (await page.textContent('body'))?.toLowerCase() ?? '';
  return body.includes('stub');
}

test.describe('hub — login round-trip (stub upstream)', () => {
  test('drives /login/stub through the stub authorize + callback to an authenticated session', async ({
    page,
    context,
  }) => {
    test.skip(!(await stubProviderAvailable(page)), 'stub provider not enabled on this hub (pre-Stage-2)');

    // Navigate the FULL redirect chain in a real browser: the hub 302s to the stub /authorize (an in-cluster
    // Service reachable from the e2e pod), the stub auto-approves and 302s back to /login/stub/callback, the hub
    // exchanges the code and establishes the session, then redirects to the post-login destination. Playwright
    // follows every hop; we just wait for it to settle.
    await page.goto('/login/stub', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // The session cookie must now be set on the context.
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === 'civ-token' || c.name === '__Secure-civ-token');
    expect(session, 'a civ-token session cookie should be set after the round-trip').toBeTruthy();

    // And it must authenticate: /api/auth/identity resolves the stub-mapped user (not 401).
    const res = await context.request.get('/api/auth/identity');
    expect(res.status(), 'identity should resolve with the round-trip session').toBe(200);
    const user = await res.json();
    expect(user?.id, 'identity should carry a user id').toBeTruthy();
  });
});
