import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * Regression guard for PR #2464 (perf/cut-ambient-bootstrap-trpc-volume): cutting
 * per-bootstrap tRPC volume on api-primary. Runs only under
 * playwright.preview.config.ts (needs PREVIEW_URL).
 *
 * What this file CAN assert deterministically (and does):
 *   1. ANON SSR-inject of `browsingSettingsAddons`. _app.getInitialProps now
 *      fetches the redis-cached global addon list server-side and seeds it into
 *      `__NEXT_DATA__.props.pageProps.browsingSettingsAddons`, passing it to
 *      BrowsingSettingsAddonsProvider as `initialData`. So the client must NOT
 *      fire `system.getBrowsingSettingAddons` on bootstrap. This fired for anon
 *      in the old code, so it's verifiable WITHOUT login. The tRPC client is
 *      non-batched (src/utils/trpc.ts httpLink), so the procedure name is in the
 *      request path — a substring match on the URL is a reliable network probe.
 *      The anon home page 307s to /login, but `_app` getInitialProps runs for
 *      every page, so the SSR payload + provider mount happen on /login too.
 *   2. The same SSR-inject for a logged-in (gate-passing) user.
 *
 * What is LEFT AS MANUAL (documented, not faked here — see checklist at bottom):
 *   - "user.getSettings is no longer force-refetched per mount" by the four
 *     ambient consumers (chat icon + 3 migration/nav alerts). getSettings fires
 *     for many unrelated reasons during a session, so a count-based "did it
 *     refetch?" assertion against a live preview is flaky and would be theatre.
 *   - Chat-icon no-flash, alert render/dismiss/persist, and the
 *     getFeatureFlags-error fail-open path. These are timing/visual and
 *     user-state dependent; assert by hand.
 */

const ADDONS_PROCEDURE = 'system.getBrowsingSettingAddons';

// A page that renders for anonymous traffic without clearing the preview gate, so
// _app.getInitialProps (and thus the SSR inject + provider mount) runs — exactly
// the bootstrap path we want to probe. Post first-party-OAuth cutover, /login is a
// server-side REDIRECT to the hub (no in-app render), so it can't be the landing
// anymore; /preview-restricted is the gate's other allow-listed exception
// (resolveAuthGuard: `path !== '/preview-restricted'`) and renders via _app for
// anyone, anonymous included.
const ANON_LANDING = '/preview-restricted';

// A core page a gate-passing user lands on directly (no /login bounce).
const AUTHED_LANDING = '/models';

/**
 * Navigate to `path`, recording every tRPC request URL seen during the load and
 * for a short settle window after, then return them. We watch `request` (fired
 * the moment the client issues it) so we catch the call even if it errors.
 */
async function collectTrpcRequests(
  page: import('@playwright/test').Page,
  path: string
): Promise<string[]> {
  const trpcUrls: string[] = [];
  const onRequest = (req: import('@playwright/test').Request) => {
    const url = req.url();
    if (url.includes('/api/trpc/')) trpcUrls.push(url);
  };
  page.on('request', onRequest);
  try {
    // NOT 'networkidle': the app keeps background requests alive (signals /
    // polling / beacons), so the network never goes idle and goto would hang to
    // the navigation timeout. We don't need it — the `request` listener above
    // captures every tRPC call regardless of load state; a fixed settle window
    // after DOMContentLoaded covers the bootstrap burst + any deferred mount.
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  } finally {
    page.off('request', onRequest);
  }
  return trpcUrls;
}

/** Read `__NEXT_DATA__.props.pageProps.browsingSettingsAddons` from the page. */
async function readBrowsingSettingsAddons(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el?.textContent) return { present: false, value: undefined as unknown };
    const data = JSON.parse(el.textContent);
    const value = data?.props?.pageProps?.browsingSettingsAddons;
    return { present: typeof value !== 'undefined', value };
  });
}

test.describe('SSR-injected browsingSettingsAddons (anonymous)', () => {
  // Explicitly anonymous: no minted session cookie.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('addons are seeded into __NEXT_DATA__ and not fetched on bootstrap', async ({ page }) => {
    const trpcUrls = await collectTrpcRequests(page, ANON_LANDING);

    // (a) SSR payload carries the addon list.
    const addons = await readBrowsingSettingsAddons(page);
    expect(addons.present, 'browsingSettingsAddons present in __NEXT_DATA__ pageProps').toBe(true);
    expect(Array.isArray(addons.value), 'browsingSettingsAddons is a list').toBe(true);

    // (b) The client never issues the now-SSR-injected procedure on bootstrap.
    const addonRequests = trpcUrls.filter((u) => u.includes(ADDONS_PROCEDURE));
    expect(
      addonRequests,
      `no ${ADDONS_PROCEDURE} tRPC request should fire on bootstrap (it is SSR-injected); saw:\n${addonRequests.join(
        '\n'
      )}`
    ).toHaveLength(0);
  });
});

test.describe('SSR-injected browsingSettingsAddons (logged-in)', () => {
  test.use({ storageState: storageStatePath('mod') });

  test('addons are seeded and not fetched on bootstrap for a gate-passing user', async ({
    page,
  }) => {
    const trpcUrls = await collectTrpcRequests(page, AUTHED_LANDING);

    const addons = await readBrowsingSettingsAddons(page);
    expect(addons.present, 'browsingSettingsAddons present in __NEXT_DATA__ pageProps').toBe(true);
    expect(Array.isArray(addons.value), 'browsingSettingsAddons is a list').toBe(true);

    const addonRequests = trpcUrls.filter((u) => u.includes(ADDONS_PROCEDURE));
    expect(
      addonRequests,
      `no ${ADDONS_PROCEDURE} tRPC request should fire on bootstrap (it is SSR-injected); saw:\n${addonRequests.join(
        '\n'
      )}`
    ).toHaveLength(0);
  });
});

/**
 * MANUAL CHECKLIST — behaviours of #2464 that are not auto-asserted above.
 * (Auth IS supported by this harness, but these are timing/visual/state cases
 * that would be flaky or no-op as live-preview assertions; verify by hand.)
 *
 *  [ ] Chat icon no-flash: logged-in user WITH chat disabled — the chat icon
 *      must NOT appear-then-disappear on load. It should gate on
 *      useFeatureFlagsReady() and only render once the user flag overlay settles.
 *  [ ] No per-mount getSettings refetch: with the ambient consumers mounted
 *      (chat icon + NavTidyNotice + YellowBuzzMigrationNotice), client-side nav
 *      between pages must NOT trigger
 *      a `user.getSettings` refetch per mount (they now read the SSR-seeded
 *      cache + gate on useFeatureFlagsReady, not staleTime:0 + isFetched).
 *  [ ] Alert render/dismiss/persist: a migration/nav alert renders from
 *      dismissedAlerts, dismissing it fires exactly one getSettings refetch via
 *      the new onSettled invalidate, and it stays dismissed across reloads.
 *  [ ] getFeatureFlags error fail-open: if user.getFeatureFlags errors,
 *      useFeatureFlagsReady() still flips true (gated on isFetched, which covers
 *      success OR error), so chat/alerts are not stuck hidden.
 */
