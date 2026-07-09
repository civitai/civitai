import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * Auth-guard tests for a deployed PR preview — the behaviors the NextAuth -> hub cutover introduced that the
 * existing smoke / moderation specs don't cover:
 *
 *   1. The _app moderator guard (server/auth/route-guard.ts, moved off the edge middleware) REDIRECTS a
 *      gate-passing NON-moderator away from /moderator. preview-smoke proves a mod can enter and
 *      preview-moderation proves the queues render — neither proves a non-mod is bounced, which is the whole
 *      point of the new guard.
 *   2. /login is now a pure server-side redirect to the centralized hub (buildHubLoginRedirect), threading the
 *      returnUrl. We assert the redirect target WITHOUT following it (the hop lands on the external hub).
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + the minted storage states).
 */

const MODERATOR_PATH = '/moderator/reports';

// tester (Flipt allowlist) + gold (allowlist + tier) both CLEAR the preview gate but lack isModerator, so the
// _app guard must bounce them from /moderator specifically.
const NON_MOD_ROLES = ['tester', 'gold'] as const;

for (const role of NON_MOD_ROLES) {
  test.describe(`_app moderator guard bounces ${role}`, () => {
    test.use({ storageState: storageStatePath(role) });

    test(`${role} cannot reach ${MODERATOR_PATH}`, async ({ page }) => {
      await page.goto(MODERATOR_PATH, { waitUntil: 'domcontentloaded' });
      // The guard sends an authed non-mod to '/' (login can't grant the missing permission, so it would loop).
      expect(page.url(), `${role} should be bounced off the moderator surface`).not.toContain('/moderator');
      // A bounce to /login would mean the session didn't resolve (a different failure) — assert it did.
      expect(page.url(), `${role} session should resolve, not bounce to login`).not.toContain('/login');
      // And it isn't the preview-access gate firing instead (these roles are allowlisted).
      expect(page.url(), `${role} should not hit preview-restricted`).not.toContain('/preview-restricted');
    });
  });
}

test.describe('_app moderator guard admits a moderator (control)', () => {
  test.use({ storageState: storageStatePath('mod') });

  test('mod stays on /moderator/reports', async ({ page }) => {
    const resp = await page.goto(MODERATOR_PATH, { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'HTTP status for /moderator/reports').toBeLessThan(400);
    await expect(page).toHaveURL(/\/moderator\/reports/);
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
