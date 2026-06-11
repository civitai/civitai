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
const ANNOUNCEMENTS_PROCEDURE = 'announcement.getAnnouncements';

// A core page a gate-passing user lands on directly (no /login bounce). Both
// procedures fire on every logged-in bootstrap regardless of which page, so
// /models is representative.
const AUTHED_LANDING = '/models';

// The anon home 307s to /login, but `_app` getInitialProps still runs and seeds
// the (non-auth-gated) announcements — same rationale as preview-bootstrap.spec.
const ANON_LANDING = '/login';

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
 * Fetch a no-input tRPC query LIVE as the logged-in user, then return its
 * JSON-serialized (pre-superjson-revival) value at `result.data.json` — exactly
 * the shape the SSR seed is delivered in (both cross the wire as JSON), so Date
 * fields are ISO strings on both sides; no revival needed for equality.
 *
 * Fetch from WITHIN the page (`page.evaluate` + same-origin `fetch`) rather than
 * `page.request` — `page.request` does not reliably carry the HttpOnly NextAuth
 * session cookie / page Origin and returns 401. A same-origin `fetch` includes
 * the session cookie automatically, mirroring what the real client sends. The
 * page must already be navigated to the preview origin before calling this.
 */
async function fetchTrpcQueryJson(
  page: Page,
  procedure: string,
  input?: unknown
): Promise<unknown> {
  const out = await page.evaluate(
    async ({ proc, inp }) => {
      // tRPC's non-batched httpLink puts a query's input in the `?input=` query
      // string as the superjson envelope `{"json": <value>}`. Procedures with no
      // input (getFeatureFlags/checkTosUpdate) omit it entirely.
      const qs =
        typeof inp === 'undefined'
          ? ''
          : `?input=${encodeURIComponent(JSON.stringify({ json: inp }))}`;
      const r = await fetch(`/api/trpc/${proc}${qs}`, {
        headers: { 'x-client': 'web' },
        credentials: 'same-origin',
      });
      return { ok: r.ok, status: r.status, text: await r.text() };
    },
    { proc: procedure, inp: input }
  );
  expect(
    out.ok,
    `live ${procedure} fetch returned HTTP ${out.status}: ${out.text.slice(0, 300)}`
  ).toBe(true);
  const body = JSON.parse(out.text);
  const entry = Array.isArray(body) ? body[0] : body;
  return entry?.result?.data?.json;
}

/**
 * Assert an announcements seed byte-equals a live fetch. Factored so the anon
 * and authed cases share it. The core assertion (`toEqual`) holds for an EMPTY
 * preview too (`[] === []`), but an all-empty run gives no field-shape signal —
 * so we surface the count via the assertion message and, when non-empty, assert
 * each item carries the resolver's expected display fields. That way a green run
 * with active announcements actually exercises the field/Date serialization.
 */
function assertAnnouncementsSeedEqualsLive(seed: unknown, live: unknown, label: string) {
  expect(
    seed,
    `announcement.getAnnouncements ${label} SSR seed must byte-equal a live resolver fetch`
  ).toEqual(live);

  const items = Array.isArray(seed) ? (seed as Array<Record<string, unknown>>) : [];
  // eslint-disable-next-line no-console
  console.log(`[ssr-inject] ${label} announcements seed length: ${items.length}`);
  for (const item of items) {
    expect(item, `${label} announcement item shape`).toMatchObject({
      id: expect.any(Number),
      title: expect.anything(),
      content: expect.anything(),
    });
  }
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

    // Normalize the wire-representation difference for "no value" fields: the SSR
    // seed crosses the wire via JSON.stringify (drops `undefined` keys) while the
    // live fetch uses superjson (encodes `undefined` as `null`). Both mean absent;
    // stripping null/undefined-valued keys compares the meaningful fields
    // apples-to-apples. `false`/0/'' are kept, so a real value-vs-absent
    // divergence is still caught. (e.g. checkTosUpdate's unused `userLastSeen`:
    // omitted in the seed, `null` in the live fetch — semantically identical.)
    const stripNullish = (o: unknown) =>
      o && typeof o === 'object'
        ? Object.fromEntries(
            Object.entries(o as Record<string, unknown>).filter(([, v]) => v != null)
          )
        : o;

    expect(
      stripNullish(seedFlags.value),
      'user.getFeatureFlags SSR seed must byte-equal a live resolver fetch'
    ).toEqual(stripNullish(liveFlags));
    expect(
      stripNullish(seedTos.value),
      'content.checkTosUpdate SSR seed must byte-equal a live resolver fetch'
    ).toEqual(stripNullish(liveTos));
  });
});

/**
 * Regression guard for the follow-up PR perf/ssr-inject-announcements: cutting
 * `announcement.getAnnouncements` (~26/s on api-primary) off the bootstrap by
 * SSR-injecting it. Unlike the two procedures above this one is NOT auth-gated —
 * it fires for anon AND authed — and it has a `{ domain }` input. We compute the
 * seed in `/api/user/settings` with `getRequestDomainColor(req)` (exactly what
 * the resolver's `applyRequestDomainColor` middleware uses) and seed the query
 * inside `useGetAnnouncements`, under the client's `useDomainColor()` key.
 *
 * The seed can legitimately be an EMPTY array (no active announcements on the
 * preview) — that is still a valid, present seed, and the byte-equality assertion
 * ([] === []) holds.
 */
test.describe('SSR-injected announcements (logged-in)', () => {
  test.use({ storageState: storageStatePath('mod') });

  test('getAnnouncements is seeded into __NEXT_DATA__ and not fetched on bootstrap', async ({
    page,
  }) => {
    const trpcUrls = await collectTrpcRequests(page, AUTHED_LANDING);

    const announcements = await readPageProp(page, 'announcements');
    expect(announcements.present, 'announcements present in __NEXT_DATA__ pageProps').toBe(true);
    expect(Array.isArray(announcements.value), 'announcements seed is an array').toBe(true);

    const announcementRequests = trpcUrls.filter((u) => u.includes(ANNOUNCEMENTS_PROCEDURE));
    expect(
      announcementRequests,
      `no ${ANNOUNCEMENTS_PROCEDURE} tRPC request should fire on bootstrap (it is SSR-injected); saw:\n${announcementRequests.join(
        '\n'
      )}`
    ).toHaveLength(0);
  });

  // The seed must byte-equal a live resolver fetch. The resolver ignores the
  // client-sent `domain` (its middleware overrides it with the host's
  // getRequestDomainColor), so we can send any non-empty domain in the input —
  // it must just be PRESENT, because the middleware writes `input.domain` and
  // would throw on an undefined input. The result reflects the host domain on
  // both the seed and the live fetch, so they match regardless.
  test('SSR seed byte-equals a live fetch', async ({ page }) => {
    await page.goto(AUTHED_LANDING, { waitUntil: 'domcontentloaded' });

    const seed = await readPageProp(page, 'announcements');
    expect(seed.present, 'announcements seed present in __NEXT_DATA__').toBe(true);

    const live = await fetchTrpcQueryJson(page, ANNOUNCEMENTS_PROCEDURE, { domain: 'blue' });

    // Both the seed (Next pageProps via JSON.stringify) and the live fetch's
    // `result.data.json` carry Date fields as ISO strings, so a structural equal
    // compares apples-to-apples without revival.
    assertAnnouncementsSeedEqualsLive(seed.value, live, 'authed');
  });
});

test.describe('SSR-injected announcements (anonymous)', () => {
  // Explicitly anonymous: no minted session cookie. Announcements is the first
  // SSR-inject that fires for anon, so this path needs its own coverage — the
  // seed's targetAudience filtering differs by userId presence.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('getAnnouncements is seeded into __NEXT_DATA__ and not fetched on bootstrap', async ({
    page,
  }) => {
    const trpcUrls = await collectTrpcRequests(page, ANON_LANDING);

    const announcements = await readPageProp(page, 'announcements');
    expect(announcements.present, 'announcements present in __NEXT_DATA__ pageProps').toBe(true);
    expect(Array.isArray(announcements.value), 'announcements seed is an array').toBe(true);

    const announcementRequests = trpcUrls.filter((u) => u.includes(ANNOUNCEMENTS_PROCEDURE));
    expect(
      announcementRequests,
      `no ${ANNOUNCEMENTS_PROCEDURE} tRPC request should fire on bootstrap (it is SSR-injected); saw:\n${announcementRequests.join(
        '\n'
      )}`
    ).toHaveLength(0);
  });

  test('SSR seed byte-equals a live anon fetch', async ({ page }) => {
    await page.goto(ANON_LANDING, { waitUntil: 'domcontentloaded' });

    const seed = await readPageProp(page, 'announcements');
    expect(seed.present, 'announcements seed present in __NEXT_DATA__').toBe(true);

    const live = await fetchTrpcQueryJson(page, ANNOUNCEMENTS_PROCEDURE, { domain: 'blue' });
    assertAnnouncementsSeedEqualsLive(seed.value, live, 'anon');
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
 *  [ ] Announcements render + dismiss: with an ACTIVE announcement, the banner
 *      renders from the SSR seed (now in the initial HTML) and dismissing it
 *      persists across navigation (the dismissed-ids zustand store is unchanged
 *      by this PR; the seed only feeds `data`).
 *  [ ] Announcements eventual freshness: a newly-published / newly-time-windowed
 *      announcement appears for an in-session user within the 5-min staleTime
 *      (on the next mount/focus) and immediately on a hard navigation (fresh
 *      getInitialProps reseed).
 */
