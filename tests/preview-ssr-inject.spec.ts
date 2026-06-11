import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * Regression guard for PR perf/ssr-inject-featureflags-tos: cutting two more
 * per-bootstrap, AUTH-GATED tRPC calls off api-primary by SSR-injecting them as
 * React Query `initialData` in _app.getInitialProps (same pattern as #2464's
 * browsingSettingsAddons inject). Runs only under playwright.preview.config.ts
 * (needs PREVIEW_URL). Auto-included by the `preview-smoke` project's
 * `preview-*.spec.ts` glob — no config change needed.
 *
 * Both procedures gate on a logged-in user (`enabled: !!session/!!currentUser`),
 * so unlike browsingSettingsAddons they NEVER fire anonymously — there is nothing
 * to assert for anon. We use the gate-passing `mod` storageState, exactly like
 * the logged-in block in preview-bootstrap.spec.ts.
 *
 * What this file CAN assert deterministically (and does), on a logged-in
 * bootstrap of /models:
 *   1. `user.getFeatureFlags` is SSR-seeded: its value is present in
 *      `__NEXT_DATA__.props.pageProps.userFeatureFlags`, AND the client never
 *      fires `user.getFeatureFlags` on bootstrap.
 *   2. `content.checkTosUpdate` is SSR-seeded: its value is present in
 *      `__NEXT_DATA__.props.pageProps.tosUpdate`, AND the client never fires
 *      `content.checkTosUpdate` on bootstrap.
 *
 * The tRPC client is non-batched (src/utils/trpc.ts httpLink), so the procedure
 * name is in the request path — a substring match on the URL is a reliable
 * network probe. We watch `request` (fired the moment the client issues it) so
 * we catch the call even if it errors, and use domcontentloaded + a fixed settle
 * window (NOT networkidle — the app keeps background requests alive and would
 * hang goto to the navigation timeout), matching preview-bootstrap.spec.ts.
 *
 * What is LEFT AS MANUAL (documented, not faked here — see checklist at bottom):
 *   - Chat-icon no-flash for a chat-disabled user (the Opt-1 readiness fix).
 *   - The ToS modal still appears for a user who has NEVER accepted (hasUpdate
 *     true on the never-seen path). Both are visual/state-dependent and flaky as
 *     live-preview assertions.
 */

const FEATURE_FLAGS_PROCEDURE = 'user.getFeatureFlags';
const TOS_PROCEDURE = 'content.checkTosUpdate';

// A core page a gate-passing user lands on directly (no /login bounce). Both
// procedures fire on every logged-in bootstrap regardless of which page, so
// /models is representative.
const AUTHED_LANDING = '/models';

/**
 * Navigate to `path`, recording every tRPC request URL seen during the load and
 * for a short settle window after, then return them.
 */
async function collectTrpcRequests(page: Page, path: string): Promise<string[]> {
  const trpcUrls: string[] = [];
  const onRequest = (req: Request) => {
    const url = req.url();
    if (url.includes('/api/trpc/')) trpcUrls.push(url);
  };
  page.on('request', onRequest);
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  } finally {
    page.off('request', onRequest);
  }
  return trpcUrls;
}

/** Read a pageProps key out of `__NEXT_DATA__`. */
async function readPageProp(page: Page, key: string) {
  return page.evaluate((k) => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el?.textContent) return { present: false, value: undefined as unknown };
    const data = JSON.parse(el.textContent);
    const value = data?.props?.pageProps?.[k];
    return { present: typeof value !== 'undefined', value };
  }, key);
}

/**
 * Fetch a no-input tRPC query LIVE via the page's authed request context
 * (inherits the storageState session cookie). The client uses a non-batched
 * httpLink + superjson, so the serialized value lives at `result.data.json`.
 * We compare that JSON-serialized (pre-superjson-revival) form, which is exactly
 * the shape the SSR seed is delivered in (both cross the wire as JSON), so Date
 * fields are ISO strings on both sides — no revival needed for equality.
 */
async function fetchTrpcQueryJson(page: Page, procedure: string): Promise<unknown> {
  const res = await page.request.get(`/api/trpc/${procedure}`, {
    headers: { 'x-client': 'web' },
  });
  expect(res.ok(), `live ${procedure} fetch returned HTTP ${res.status()}`).toBe(true);
  const body = await res.json();
  const entry = Array.isArray(body) ? body[0] : body;
  return entry?.result?.data?.json;
}

test.describe('SSR-injected getFeatureFlags + checkTosUpdate (logged-in)', () => {
  test.use({ storageState: storageStatePath('mod') });

  test('both procedures are seeded into __NEXT_DATA__ and not fetched on bootstrap', async ({
    page,
  }) => {
    const trpcUrls = await collectTrpcRequests(page, AUTHED_LANDING);

    // (a) SSR payload carries the per-user feature-flag overlay (an object).
    const userFeatureFlags = await readPageProp(page, 'userFeatureFlags');
    expect(userFeatureFlags.present, 'userFeatureFlags present in __NEXT_DATA__ pageProps').toBe(
      true
    );
    expect(
      typeof userFeatureFlags.value === 'object' && userFeatureFlags.value !== null,
      'userFeatureFlags is an object'
    ).toBe(true);

    // (b) SSR payload carries the checkTosUpdate snapshot (an object with the
    //     resolver's return shape). hasUpdate may be true/false/a date — we only
    //     assert the object is present.
    const tosUpdate = await readPageProp(page, 'tosUpdate');
    expect(tosUpdate.present, 'tosUpdate present in __NEXT_DATA__ pageProps').toBe(true);
    expect(
      typeof tosUpdate.value === 'object' && tosUpdate.value !== null,
      'tosUpdate is an object'
    ).toBe(true);

    // (c) The client never issues either now-SSR-injected procedure on bootstrap.
    const featureFlagRequests = trpcUrls.filter((u) => u.includes(FEATURE_FLAGS_PROCEDURE));
    expect(
      featureFlagRequests,
      `no ${FEATURE_FLAGS_PROCEDURE} tRPC request should fire on bootstrap (it is SSR-injected); saw:\n${featureFlagRequests.join(
        '\n'
      )}`
    ).toHaveLength(0);

    const tosRequests = trpcUrls.filter((u) => u.includes(TOS_PROCEDURE));
    expect(
      tosRequests,
      `no ${TOS_PROCEDURE} tRPC request should fire on bootstrap (it is SSR-injected); saw:\n${tosRequests.join(
        '\n'
      )}`
    ).toHaveLength(0);
  });

  // The core correctness property: the SSR-injected seed must be byte-identical
  // to what a live resolver fetch returns. With `staleTime: Infinity` a wrong
  // seed would never self-correct (until reload), so a divergence here means
  // users are served wrong feature flags / ToS state. Both paths call the same
  // shared fn (computeUserFeatureFlagsOverlay / checkTosUpdate) so this should
  // hold by construction — this asserts it for a real authed user end-to-end.
  test('SSR seed byte-equals a live fetch for both procedures', async ({ page }) => {
    await page.goto(AUTHED_LANDING, { waitUntil: 'domcontentloaded' });

    const seedFlags = await readPageProp(page, 'userFeatureFlags');
    const seedTos = await readPageProp(page, 'tosUpdate');
    expect(seedFlags.present, 'userFeatureFlags seed present in __NEXT_DATA__').toBe(true);
    expect(seedTos.present, 'tosUpdate seed present in __NEXT_DATA__').toBe(true);

    const liveFlags = await fetchTrpcQueryJson(page, FEATURE_FLAGS_PROCEDURE);
    const liveTos = await fetchTrpcQueryJson(page, TOS_PROCEDURE);

    expect(
      seedFlags.value,
      'user.getFeatureFlags SSR seed must byte-equal a live resolver fetch'
    ).toEqual(liveFlags);
    expect(
      seedTos.value,
      'content.checkTosUpdate SSR seed must byte-equal a live resolver fetch'
    ).toEqual(liveTos);
  });
});

/**
 * MANUAL CHECKLIST — behaviours of this PR that are not auto-asserted above.
 * (Auth IS supported by this harness, but these are timing/visual/state cases
 * that would be flaky or no-op as live-preview assertions; verify by hand.)
 *
 *  [ ] Opt-1 readiness fix / chat-icon no-flash: a logged-in user WITH chat
 *      disabled must NOT see the chat icon appear-then-disappear on load. With
 *      the SSR seed, `useFeatureFlagsReady()` is true from frame 0 (gated on
 *      `isSuccess`, which `initialData` sets immediately) so the icon resolves
 *      correctly without a fetch. Confirm there is no flash and the three
 *      migration/nav alerts still render (they also gate on readiness).
 *  [ ] Opt-1 no-seed/error fail-open: if the SSR `/api/user/settings` snapshot
 *      fails (no seed) OR `user.getFeatureFlags` errors client-side, readiness
 *      still flips true (`isSuccess || isError`) so chat/alerts are not stuck
 *      hidden, and the overlay self-heals via a real fetch.
 *  [ ] Opt-1 live toggle: toggling a feature in account settings still updates
 *      live (the toggle mutation's optimistic setData + invalidate refetch the
 *      seeded query — invalidate refetches regardless of staleTime).
 *  [ ] Opt-2 ToS-never-accepted: a user who has NEVER accepted the ToS still
 *      gets the ToS modal on first load (the `hasUpdate=true` when last-seen is
 *      undefined path), seeded from SSR rather than a client fetch.
 *  [ ] Opt-2 ToS accept persists: accepting the ToS dismisses the modal (the
 *      accept flow's setData patches `hasUpdate=false`) and it stays dismissed
 *      on reload; the domain→field mapping is correct on green/red/blue hosts.
 */
