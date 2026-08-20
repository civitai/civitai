import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * Auth-guard tests for a deployed PR preview — the behaviors the NextAuth -> hub cutover introduced that the
 * existing smoke / moderation specs don't cover:
 *
 *   1. The _app moderator guard (server/auth/route-guard.ts, moved off the edge middleware) REDIRECTS a
 *      gate-passing NON-moderator away from /moderator. preview-moderation proves the surviving moderator
 *      surfaces render for a mod — neither proves a non-mod is bounced, which is the whole point of the new
 *      guard.
 *   2. /login is now a pure server-side redirect to the centralized hub (buildHubLoginRedirect), threading the
 *      returnUrl. We assert the redirect target WITHOUT following it (the hop lands on the external hub).
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + the minted storage states).
 */

// #3573 migrated this path to the standalone moderator app (shared/constants/migrated-moderator-routes.ts:
// `reports` -> `reports`), so for a MODERATOR it now ends in a 3xx to that app. It is still the right probe
// for the guard: the guard runs in _app.getInitialProps, ahead of the catchall's getServerSideProps, so a
// non-mod is bounced before the migration redirect can matter (which is why the two bounce tests below are
// unaffected by the migration), and for a mod the Location tells us WHICH hop happened.
const MODERATOR_PATH = '/moderator/reports'; // @migrated-route-probe — asserting the hop IS the point

// tester (Flipt allowlist) + gold (allowlist + tier) both CLEAR the preview gate but lack isModerator, so the
// _app guard must bounce them from /moderator specifically.
const NON_MOD_ROLES = ['tester', 'gold'] as const;

for (const role of NON_MOD_ROLES) {
  test.describe(`_app moderator guard bounces ${role}`, () => {
    test.use({ storageState: storageStatePath(role) });

    test(`${role} cannot reach ${MODERATOR_PATH}`, async ({ page }) => {
      await page.goto(MODERATOR_PATH, { waitUntil: 'domcontentloaded' });
      // The guard sends an authed non-mod to '/' (login can't grant the missing permission, so it would loop).
      expect(page.url(), `${role} should be bounced off the moderator surface`).not.toContain(
        '/moderator'
      );
      // A bounce to /login would mean the session didn't resolve (a different failure) — assert it did.
      expect(page.url(), `${role} session should resolve, not bounce to login`).not.toContain(
        '/login'
      );
      // And it isn't the preview-access gate firing instead (these roles are allowlisted).
      expect(page.url(), `${role} should not hit preview-restricted`).not.toContain(
        '/preview-restricted'
      );
    });
  });
}

test.describe('_app moderator guard admits a moderator (control)', () => {
  test.use({ storageState: storageStatePath('mod') });

  test('mod is not bounced — the only hop is the moderator-app migration redirect', async ({
    page,
  }) => {
    // Inspect the 3xx Location WITHOUT following it — same idiom (and same reason) as the /login test below:
    // the hop leaves this origin for the standalone moderator app, which a preview cannot exercise
    // (MODERATOR_APP_URL defaults to production — server-schema.ts). `page.request` shares the browser
    // context's cookies (minted by preview-auth.setup.ts) and its baseURL, so this is the mod's session.
    const res = await page.request.get(MODERATOR_PATH, { maxRedirects: 0 });
    expect(res.status(), `HTTP status for ${MODERATOR_PATH}`).toBeGreaterThanOrEqual(300);
    expect(res.status(), `HTTP status for ${MODERATOR_PATH}`).toBeLessThan(400);

    const location = res.headers()['location'] ?? '';
    expect(location, `${MODERATOR_PATH} should set a redirect Location`).not.toBe('');
    // The GUARD has exactly two bounces (route-guard.ts): '/' for an authed non-moderator, and
    // '/login?returnUrl=…' when the session didn't resolve. Neither may fire for a mod — that IS this
    // control. (The login bounce percent-encodes its returnUrl, so it can't spell a literal '/reports'.)
    expect(location, 'a mod must not be bounced home by the _app guard').not.toBe('/');
    expect(location, 'a mod session should resolve, not bounce to login').not.toContain('/login');
    // …so the hop is the migration one. Deploy-agnostic: MODERATOR_APP_URL is env-per-deploy, so pin the
    // PATH the mapping produces, not the host.
    expect(location, 'mod should be forwarded to the moderator app /reports').toMatch(/\/reports$/);
  });
});

test.describe('/login forwards to the centralized hub', () => {
  test('threads the returnUrl into the hub redirect', async ({ playwright, baseURL }) => {
    // Inspect the 3xx Location WITHOUT following it — the target is the external hub. A fresh, cookieless
    // request context is an anonymous /login hit (/login is exempt from the preview gate).
    const ctx = await playwright.request.newContext({ baseURL });
    try {
      const res = await ctx.get('/login?returnUrl=%2Fmodels', { maxRedirects: 0 });
      expect(res.status(), '/login should redirect').toBeGreaterThanOrEqual(300);
      expect(res.status(), '/login should redirect').toBeLessThan(400);

      const location = res.headers()['location'] ?? '';
      expect(location, '/login should set a redirect Location').not.toBe('');
      // Deploy-agnostic: don't pin the hub host (env-per-deploy). The hop targets a hub /login and the original
      // dest survives it — only the '/' encodes (%2F / %252F …); the letters 'models' stay literal at any depth.
      expect(location.toLowerCase(), 'should target the hub login').toContain('login');
      expect(location, 'returnUrl dest should survive the hop').toContain('models');
    } finally {
      await ctx.dispose();
    }
  });
});
