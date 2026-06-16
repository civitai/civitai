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
 *   2. The static ToS metadata is SSR-delivered: it's present in
 *      `__NEXT_DATA__.props.pageProps.tosMeta`, AND the client never fires a
 *      `content.checkTosUpdate` request (that route no longer exists — the modal
 *      decision is computed client-side from `tosMeta` + the seeded getSettings).
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
const FOLLOWING_PROCEDURE = 'user.getFollowingUsers';

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
      // string as the superjson envelope `{"json": <value>}`. No-input procedures
      // (e.g. getFeatureFlags) omit it entirely.
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

test.describe('SSR-injected getFeatureFlags + ToS metadata (logged-in)', () => {
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

    // (b) SSR payload carries the static ToS metadata (lastmod + body hash +
    //     per-domain field keys). The show/hide decision is computed client-side,
    //     so we just assert the metadata object is present and carries a hash.
    const tosMeta = await readPageProp(page, 'tosMeta');
    expect(tosMeta.present, 'tosMeta present in __NEXT_DATA__ pageProps').toBe(true);
    expect(
      typeof tosMeta.value === 'object' && tosMeta.value !== null,
      'tosMeta is an object'
    ).toBe(true);
    expect(
      typeof (tosMeta.value as { hash?: unknown }).hash === 'string',
      'tosMeta carries a content hash'
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

  // The core correctness property for getFeatureFlags: the SSR-injected seed must
  // be byte-identical to a live resolver fetch (with `staleTime: Infinity` a wrong
  // seed would never self-correct until reload). ToS metadata has NO resolver
  // anymore — it's static deploy data delivered via pageProps — so we assert its
  // static shape instead of a live comparison.
  test('feature-flag SSR seed byte-equals a live fetch; tosMeta carries static fields', async ({
    page,
  }) => {
    await page.goto(AUTHED_LANDING, { waitUntil: 'domcontentloaded' });

    const seedFlags = await readPageProp(page, 'userFeatureFlags');
    const seedTos = await readPageProp(page, 'tosMeta');
    expect(seedFlags.present, 'userFeatureFlags seed present in __NEXT_DATA__').toBe(true);
    expect(seedTos.present, 'tosMeta seed present in __NEXT_DATA__').toBe(true);

    const liveFlags = await fetchTrpcQueryJson(page, FEATURE_FLAGS_PROCEDURE);

    // Normalize the wire-representation difference for "no value" fields: the SSR
    // seed crosses the wire via JSON.stringify (drops `undefined` keys) while the
    // live fetch uses superjson (encodes `undefined` as `null`). Both mean absent;
    // stripping null/undefined-valued keys compares the meaningful fields
    // apples-to-apples. `false`/0/'' are kept, so a real value-vs-absent
    // divergence is still caught.
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

    // tosMeta is static deploy data. Assert the fields the client relies on are
    // present: current body hash + rollout baseline + the per-domain settings field
    // keys it compares/writes.
    const tos = seedTos.value as {
      hash?: unknown;
      baselineHash?: unknown;
      fieldKey?: unknown;
      hashFieldKey?: unknown;
    };
    expect(typeof tos.hash, 'tosMeta.hash is a string').toBe('string');
    expect(typeof tos.baselineHash, 'tosMeta.baselineHash is a string').toBe('string');
    expect(typeof tos.fieldKey, 'tosMeta.fieldKey is a string').toBe('string');
    expect(typeof tos.hashFieldKey, 'tosMeta.hashFieldKey is a string').toBe('string');
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

  // No anon "byte-equals a live fetch" test: the preview-auth gate blocks ALL
  // anonymous /api/trpc/* and 302-redirects to /login, so an anonymous live
  // fetch of announcement.getAnnouncements returns the login HTML (200), never
  // tRPC JSON — JSON.parse then fails on "<!DOCTYPE". A live-fetch comparison is
  // only possible with an authed session, and that byte-equality is already
  // covered by the "announcements (logged-in) › SSR seed byte-equals a live
  // fetch" test above. The anon coverage that matters — seed present in
  // __NEXT_DATA__ and NO getAnnouncements request on bootstrap (the SSR-inject
  // contract) — is asserted in the test above.
});

/**
 * Regression guard for the SSR-inject of `user.getFollowingUsers` (~27/s on
 * api-primary). AUTH-GATED (the consumers gate on `enabled: !!currentUser`), so
 * it NEVER fires anonymously — authed block only, like getFeatureFlags/tos.
 * Seeded directly in AppProvider (fixed `undefined` key) and inheriting the
 * global `staleTime: Infinity`, so a seeded query never refetches. The payload
 * is a plain `number[]` of followed userIds — no Date/serialization subtlety, so
 * the seed (JSON) and a live fetch (`result.data.json`) compare directly.
 */
test.describe('SSR-injected getFollowingUsers (logged-in)', () => {
  test.use({ storageState: storageStatePath('mod') });

  test('getFollowingUsers is seeded into __NEXT_DATA__ and not fetched on bootstrap', async ({
    page,
  }) => {
    const trpcUrls = await collectTrpcRequests(page, AUTHED_LANDING);

    const following = await readPageProp(page, 'following');
    expect(following.present, 'following present in __NEXT_DATA__ pageProps').toBe(true);
    expect(Array.isArray(following.value), 'following seed is an array').toBe(true);

    const followingRequests = trpcUrls.filter((u) => u.includes(FOLLOWING_PROCEDURE));
    expect(
      followingRequests,
      `no ${FOLLOWING_PROCEDURE} tRPC request should fire on bootstrap (it is SSR-injected); saw:\n${followingRequests.join(
        '\n'
      )}`
    ).toHaveLength(0);
  });

  test('SSR seed byte-equals a live fetch', async ({ page }) => {
    await page.goto(AUTHED_LANDING, { waitUntil: 'domcontentloaded' });

    const seed = await readPageProp(page, 'following');
    expect(seed.present, 'following seed present in __NEXT_DATA__').toBe(true);

    const live = await fetchTrpcQueryJson(page, FOLLOWING_PROCEDURE);
    expect(
      seed.value,
      'user.getFollowingUsers SSR seed must byte-equal a live resolver fetch'
    ).toEqual(live);

    // The byte-equality above holds trivially for a user who follows nobody
    // (`[] === []`) — surface the length so an all-empty run is visible (not a
    // silent no-op), and when non-empty assert the payload is a number[] of
    // userIds (mirrors the announcements test's non-empty shape check).
    const ids = Array.isArray(seed.value) ? (seed.value as unknown[]) : [];
    // eslint-disable-next-line no-console
    console.log(`[ssr-inject] following seed length: ${ids.length}`);
    for (const id of ids) {
      expect(typeof id, 'following item is a userId (number)').toBe('number');
    }
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
 *      gets the ToS modal on first load (no stored hash/date → `hasUpdate` true),
 *      computed client-side from `tosMeta` + the SSR-seeded getSettings.
 *  [ ] Opt-2 ToS accept persists: accepting the ToS dismisses the modal (the
 *      accept mutation patches the getSettings cache with the new hash, so the
 *      hook recomputes `hasUpdate=false`) and it stays dismissed on reload; the
 *      domain→field mapping is correct on green/red/blue hosts.
 *  [ ] Opt-2 ToS no false-positive: a stray `lastmod` bump with NO body change
 *      must NOT re-prompt a hash-backed user (the body hash is unchanged).
 *  [ ] Announcements render + dismiss: with an ACTIVE announcement, the banner
 *      renders from the SSR seed (now in the initial HTML) and dismissing it
 *      persists across navigation (the dismissed-ids zustand store is unchanged
 *      by this PR; the seed only feeds `data`).
 *  [ ] Announcements eventual freshness: a newly-published / newly-time-windowed
 *      announcement appears for an in-session user within the 5-min staleTime
 *      (on the next mount/focus) and immediately on a hard navigation (fresh
 *      getInitialProps reseed).
 */
