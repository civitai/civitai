import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the
// real module's type.
import type * as TrpcMod from '~/utils/trpc';

/**
 * Regression: `AppsSubNav` HYDRATION SAFETY (prod incident — every /apps page inert).
 *
 * The conditional sub-nav tabs (Installed / Invites / Revenue / Review) are driven by the
 * client-only `blocks.getNavSummary` query. tRPC runs with `ssr:false`, so the SERVER
 * always renders the deferred-off set (`EMPTY_SUMMARY`), while the query's data is
 * present in the CLIENT's FIRST render. For a user with
 * installs/invites/approved-apps/reviewer status the first client paint rendered 6 tabs
 * against the server's 2 — a React hydration mismatch (#418/#425) that bailed hydration
 * of the ENTIRE /apps page ROOT, leaving every /apps page un-hydrated and inert (dead
 * buttons; the `/apps/submit?edit=` query never fired → a permanent "Loading your
 * listing…").
 *
 * The fix gates the SUMMARY-driven tabs on `useIsClient()` (false on the server AND
 * the first client paint, true only AFTER mount) so the server render and the first
 * client render are IDENTICAL — those tabs reveal only post-hydration.
 *
 * ── THE CAPABILITY GATES ARE DELIBERATELY *NOT* `isClient`-DEFERRED ───────────────
 * The `Build` row is gated on `canAccessAppsBuild(currentUser, features)` and
 * `Marketplace` on `hasAppsStoreAccess(features)`. Every input to both is SSR-seeded and
 * FROZEN — the store flags, `appBlocksAuthor` and `appBlocksGetStarted` all come from
 * `pageProps.flags` (resolved server-side in `_app.getInitialProps`, frozen by
 * `useState(initialFlags)`; NONE of them is a `toggleable` flag, so the client
 * `user.getFeatureFlags` overlay cannot move them), and `isModerator` rides
 * `SessionProvider`'s `useState(initial)` seed. So they are safe on the FIRST paint, and
 * these tests pin the distinction: the summary tabs stay deferred, the capability tabs do
 * not, and the pre-mount output must not vary with the query's data.
 *
 * 🔴 WHAT CHANGED WITH THE `/apps/build` CONSOLIDATION. "Build apps"
 * (`/apps/get-started`), "Create" (`/apps/submit`) and "My apps" (`/apps/mine`) were
 * replaced by one "Build" row (`/apps/build`), and `Marketplace` stopped being
 * unconditional. The load-bearing consequence for THIS file: the one row still gated on
 * `context.isAuthor` — `Invites` — is ALSO summary-driven, so an author and a non-author
 * with the same flags now render the SAME pre-mount set. That is not a weakening of the
 * pairs below, it is the invariant itself: an author's extra tab MUST NOT appear before
 * mount, or hydration breaks exactly as it did in the incident.
 *
 * These tests drive the `AppsSubNav` CONTAINER (not the pure `AppsSubNavView`) so the
 * `useIsClient` gate + the `canAccessAppsBuild` / `isAppDeveloper` derivations are all
 * exercised.
 * (The REAL `renderToString` → `hydrateRoot` check, with a console.error positive
 * control, lives in `AppsSubNav.ssrHydration.browser.test.tsx`.)
 */

const ALL_TRUE_SUMMARY = {
  hasInstalls: true,
  hasActivity: true,
  hasSubmissions: true,
  hasApprovedApps: true,
  isReviewer: true,
  hasEditableApps: true,
  hasPendingInvites: true,
};

const mocks = vi.hoisted(() => ({
  // Controls `useIsClient()` — false simulates the server + the first client paint
  // (pre-mount), true simulates a post-mount render.
  isClient: false,
  // The resolved `getNavSummary` data available to the CLIENT render.
  navSummary: undefined as undefined | typeof ALL_TRUE_SUMMARY,
  // `useFeatureFlags()` — SSR-seeded + frozen in the real provider.
  flags: { appBlocks: true, appBlocksAuthor: true } as Record<string, boolean>,
  // `useCurrentUser()` — SSR-seeded via SessionProvider; `null` = logged out.
  user: null as null | { id: number; username: string; isModerator?: boolean },
}));

vi.mock('~/providers/IsClientProvider', () => ({
  useIsClient: () => mocks.isClient,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => mocks.flags,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.user,
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-
// mock): a hand-written replacement silently breaks every importer the day
// '~/utils/trpc' grows an export this factory omits — the whole FILE then fails to
// load with 0 tests collected and no failing assertion.
//
// ⚠️ This mock IGNORES `enabled:` on purpose — the question here is the `useIsClient`
// deferral, and forcing the data in regardless of the query gate is what makes the
// deferral observable (and what makes `isAuthor`'s session-scoping observable for a
// logged-out viewer, whose real query would never run). The sibling
// `AppsSubNav.storeGate.browser.test.tsx` HONOURS `enabled` and pins the production
// wiring.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: { blocks: { getNavSummary: { useQuery: () => ({ data: mocks.navSummary }) } } },
}));

const { AppsSubNav } = await import('./AppsSubNav');

function tab(name: string) {
  return page.getByRole('tab', { name });
}

/** The tab labels currently in the document, in DOM order. */
function renderedTabs(): string[] {
  return page
    .getByRole('tab')
    .elements()
    .map((el) => (el.textContent ?? '').trim());
}

/**
 * 🔴 RENDER BARRIER — required before every "renders nothing" assertion.
 *
 * `render()` commits through a React 18 concurrent root on a LATER task, so a
 * synchronous `expect(renderedTabs()).toEqual([])` right after `renderWithProviders`
 * reads an EMPTY container and passes whatever the component does. Caught by mutation:
 * deleting the `links.length < 2` hide left these tests green until the barrier was
 * added. Render the sentinel alongside the component and AWAIT it first.
 */
const RENDER_BARRIER = 'render-barrier';
const RenderBarrier = () => <div data-testid={RENDER_BARRIER} />;

/** Render `AppsSubNav` behind a render barrier and wait for the commit. */
async function renderSubNav() {
  renderWithProviders(
    <>
      <RenderBarrier />
      <AppsSubNav />
    </>
  );
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

// Every row driven by the client-only `getNavSummary`, i.e. every tab that must stay
// hidden until after mount. `Invites` is included and is the strongest of the four: it
// reads BOTH the summary and `context.isAuthor`, so a mutant that lifted it out of the
// deferral would leak an author-only tab into the SSR set.
const CONDITIONAL = ['Activity', 'Invites', 'Revenue', 'Review'] as const;

beforeEach(() => {
  mocks.isClient = false;
  // Simulate the query data being present on the client (the prod condition): a user
  // whose summary is fully populated.
  mocks.navSummary = { ...ALL_TRUE_SUMMARY };
  // Default viewer: an AUTHOR (this is the shape the original incident was found in —
  // a mod), so the pre-mount set is the two-tab bar and the bar renders.
  mocks.flags = { appBlocks: true, appBlocksAuthor: true };
  mocks.user = { id: 1, username: 'dev', isModerator: false };
});

describe('AppsSubNav container — hydration-safe conditional tabs', () => {
  test('pre-mount (server + first client paint) renders ONLY the SSR-frozen tabs, even when the query already has a full summary', async () => {
    mocks.isClient = false; // server / first client paint
    await renderSubNav();

    // The two capability-driven tabs render — their inputs are SSR-frozen.
    await expect.element(tab('Build')).toBeInTheDocument();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);

    // The conditional tabs MUST NOT render pre-mount — this is what keeps the first
    // client paint identical to the SSR HTML (the fix). Before the fix, the query
    // data leaked into the first render and produced these tabs → hydration mismatch.
    for (const name of CONDITIONAL) {
      expect(tab(name).elements()).toHaveLength(0);
    }
  });

  test('post-mount (isClient=true) reveals the conditional tabs from the summary', async () => {
    mocks.isClient = true; // after mount / hydration has matched
    await renderSubNav();

    for (const name of ['Marketplace', 'Build', ...CONDITIONAL]) {
      await expect.element(tab(name)).toBeInTheDocument();
    }
    expect(renderedTabs()).toEqual([
      'Marketplace',
      'Activity',
      'Invites',
      'Revenue',
      'Build',
      'Review',
    ]);
  });

  test('pre-mount with NO summary data also shows only the SSR-frozen tabs (server parity)', async () => {
    mocks.isClient = false;
    mocks.navSummary = undefined; // server: query never resolved
    await renderSubNav();

    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
    for (const name of CONDITIONAL) {
      expect(tab(name).elements()).toHaveLength(0);
    }
  });

  /**
   * 🔴 `hasSubmissions` AND `hasEditableApps` NO LONGER DRIVE ANY TAB, AND THAT IS A
   * HYDRATION PROPERTY, NOT A TIDY-UP. They used to light "My apps"; `/apps/build`
   * absorbed it, and the replacement row deliberately does NOT consult them — they come
   * from the client-only summary, so a Build tab keyed on them would appear only after
   * mount for exactly the population most likely to have it (an author with apps), which
   * is the incident above. `resolveAppsBuildState` reads them instead, on the page.
   *
   * Pinned POST-mount, where the summary is fully applied: if either flag were wired into
   * the table there would be a seventh tab here.
   */
  test('🔴 hasSubmissions / hasEditableApps add no tab post-mount either', async () => {
    mocks.isClient = true;
    mocks.navSummary = {
      ...ALL_TRUE_SUMMARY,
      hasInstalls: false,
      hasActivity: false,
      hasApprovedApps: false,
      isReviewer: false,
      hasPendingInvites: false,
      // …leaving hasSubmissions + hasEditableApps as the only true flags.
    };
    await renderSubNav();
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
    for (const retired of ['My apps', 'My submissions', 'Create', 'Build apps']) {
      expect(tab(retired).elements(), `a tab named "${retired}" is rendered`).toHaveLength(0);
    }
  });
});

/**
 * 🔴 SSR TAB SET ≡ FIRST CLIENT RENDER.
 *
 * The server render (query never resolved) and the first client paint (query data
 * already in the cache) are BOTH `isClient === false`. The invariant that keeps
 * hydration matching is that the pre-mount output must be a function of the SSR-seeded
 * inputs ONLY — the query's data must not be able to change it.
 *
 * Each cohort is asserted TWICE against the SAME pinned literal (once with the data
 * absent = the server, once with it present = the first client paint) rather than by
 * comparing one render to another: a pinned literal cannot be satisfied by two renders
 * that are equally wrong, and both pairs below are deliberately NON-EMPTY so the equality
 * is not an `[] === []` that any broken render would also satisfy.
 *
 * 🔴 THE TWO COHORTS NOW PIN THE SAME LITERAL, AND THAT IS THE POINT. Before the
 * consolidation the author pair carried an extra "Create" tab. The only `isAuthor`-gated
 * row left is `Invites`, which is ALSO summary-driven and therefore deferred — so an
 * author and a non-author with the same flags MUST be indistinguishable before mount.
 * The AUTHOR pair's second arm is where that bites: its summary has `hasPendingInvites`,
 * so lifting `Invites` out of the `useIsClient` deferral makes it fail while the
 * non-author pair stays green.
 */
describe('AppsSubNav container — SSR tab set === first client render', () => {
  // 🔴 BOTH COHORTS HOLD `appBlocksGetStarted`, DELIBERATELY. The pairs assert
  // SSR ≡ first-client-paint against a pinned literal, and an EMPTY literal is
  // satisfied by two renders that are equally broken — a non-author without this flag
  // has `canBuild: false`, qualifies for Marketplace alone, and the `< 2` collapse would
  // make both sides `[]`. Adding the flag makes the pinned set non-empty on both sides,
  // which is strictly stronger. It also puts `context.canBuild` under the invariant:
  // like `canSeeStore`, it is applied OUTSIDE the `useIsClient` deferral, so if it were
  // ever sourced from something client-only the "Build" tab would appear on one side of
  // a pair and not the other and these tests would fail. (The cohorts WITHOUT the flag —
  // where the collapse fires — are pinned in the last describe of this file and in
  // `AppsSubNav.storeGate.browser.test.tsx`.)
  const NON_AUTHOR = () => {
    // A store-visible non-author who reaches `/apps/build` on the get-started term alone.
    // ⚠️ THIS IS A SHAPE, NOT A LIVE COHORT, and the "verified live" claim that used to sit
    // here is withdrawn: `app-blocks-author` rolls out to the same segment as `app-listings`,
    // so `{appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: true}` on a non-mod
    // is empty under the current Flipt state. The fixture is what the invariant needs; it is
    // not evidence about who holds these flags today.
    mocks.flags = { appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: true };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
  };
  const AUTHOR = () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true, appBlocksGetStarted: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
  };
  test('NON-AUTHOR, server render (no query data) → Build + Marketplace', async () => {
    NON_AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = undefined;
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });

  test('NON-AUTHOR, first client paint (query data PRESENT) → the identical set', async () => {
    NON_AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = { ...ALL_TRUE_SUMMARY }; // the prod condition that broke hydration
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });

  test('AUTHOR, server render (no query data) → Build + Marketplace', async () => {
    AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = undefined;
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });

  test('AUTHOR, first client paint (query data PRESENT, invites pending) → the identical set', async () => {
    AUTHOR();
    mocks.isClient = false;
    mocks.navSummary = { ...ALL_TRUE_SUMMARY };
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    // Non-empty on BOTH sides of the pair: the capability gates applied on the first
    // paint (Build is here pre-mount) while the summary gate did NOT — including the
    // author-only `Invites`, whose summary flag is true in this fixture.
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
    expect(tab('Invites').elements()).toHaveLength(0);
  });

  test('POSITIVE CONTROL: the same reader DOES see the conditional tabs post-mount', async () => {
    // Guards every pinned pre-mount literal above against being vacuously green — if
    // `renderedTabs()` were wired to nothing it would return the same short list here.
    NON_AUTHOR();
    mocks.isClient = true;
    mocks.navSummary = { ...ALL_TRUE_SUMMARY };
    await renderSubNav();
    await expect.element(tab('Activity')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Activity', 'Revenue', 'Build', 'Review']);
    // Invites is the one tab the author gate removes — this viewer has a pending invite
    // in the summary and still must not get it.
    expect(renderedTabs()).not.toContain('Invites');
  });
});

/**
 * The build-capability derivation IN THE CONTAINER — the half that `AppsSubNavView`
 * (props-only) cannot cover: that `AppsSubNav` feeds the SHARED
 * `canAccessAppsBuild(currentUser, features)`, the same call `resolveBuildPageAccess`
 * makes in `/apps/build`'s `getServerSideProps`, rather than an inlined flag read.
 *
 * These tests carry the intent of the old "the Create tab keys off isAppDeveloper" block:
 * the authoring row's visibility must be the page's own gate. The predicate widened
 * (`store && (isAppDeveloper || appBlocksGetStarted)`), so both disjuncts and the
 * moderator floor inside `isAppDeveloper` are exercised here.
 */
describe('AppsSubNav container — the Build tab keys off canAccessAppsBuild', () => {
  beforeEach(() => {
    mocks.isClient = true; // post-mount, so the full tab set is observable
    mocks.navSummary = { ...ALL_TRUE_SUMMARY };
  });

  test('non-mod with NEITHER the author capability nor get-started → no Build tab', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument(); // positive control
    expect(tab('Build').elements()).toHaveLength(0);
  });

  test('non-mod WITH the author capability → Build tab', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
    await renderSubNav();
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(tab('Build').element().getAttribute('href')).toBe('/apps/build');
  });

  test('non-mod, non-author WITH appBlocksGetStarted → Build tab (the second disjunct)', async () => {
    // The kill-switch term: `app-blocks-get-started` governs whether a store-visible
    // NON-author is shown the recruiting pitch. Fails if the row is narrowed to
    // `isAppDeveloper` alone.
    mocks.flags = { appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: true };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    await renderSubNav();
    await expect.element(tab('Build')).toBeInTheDocument();
  });

  test('🔴 MODERATOR FLOOR: a mod keeps Build even with appBlocksAuthor=false', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 1, username: 'mod', isModerator: true };
    await renderSubNav();
    await expect.element(tab('Build')).toBeInTheDocument();
  });

  test('the flags being ABSENT entirely behaves as false for a non-mod', async () => {
    // Flipt-down / flags-not-yet-created: `appBlocksAuthor` and `appBlocksGetStarted`
    // are simply missing. `canAccessAppsBuild` fails CLOSED.
    mocks.flags = { appBlocks: true };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(tab('Build').elements()).toHaveLength(0);
  });

  /**
   * 🔴 THE SESSION-SCOPING ASYMMETRY BETWEEN `isAuthor` AND `canBuild`, ASSERTED.
   *
   * This replaces the old "a logged-out viewer never gets Create, even if the flag reads
   * true" test, whose subject is gone. The rule it was really pinning — that the
   * container's `isAuthor` is resolved INSIDE the `currentUser ?` branch — survives on
   * `Invites`, and the new half is its mirror image: `canBuild` is deliberately NOT
   * session-scoped, because `canAccessAppsBuild` takes the user as an argument and
   * handles the anon case itself. Folding it into the `currentUser` branch would hide the
   * tab from a logged-out viewer `/apps/build` would happily serve state A to — and that
   * "simplification" is exactly what this asserts against.
   *
   * ⚠️ The summary data is forced in for an anon viewer, which production's `enabled:
   * !!currentUser` prevents (see the mock note at the top). That is what makes
   * `isAuthor`'s session-scoping observable at all; the real query gate is pinned in the
   * storeGate suite.
   */
  test('🔴 logged out: canBuild still resolves (Build renders) while isAuthor does not (no Invites)', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: true };
    mocks.user = null;
    mocks.navSummary = { ...ALL_TRUE_SUMMARY }; // hasPendingInvites: true
    await renderSubNav();
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Activity', 'Revenue', 'Build', 'Review']);
    expect(tab('Invites').elements()).toHaveLength(0);
  });

  test('a logged-out viewer with no capability at all gets no bar', async () => {
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = null;
    mocks.navSummary = undefined; // the summary query is protected — no data for anon
    await renderSubNav(); // barrier awaited inside — absence below is a real observation
    // Marketplace is all that qualifies (`canBuild` needs one of the two capability
    // terms), so the `< 2` collapse removes the bar entirely.
    expect(renderedTabs()).toEqual([]);
  });

  test('🔴 a logged-out viewer WITH appBlocksGetStarted does get Build (positive control)', async () => {
    // The control for the `toEqual([])` above — the same reader observes a bar as soon
    // as one qualifying tab is added, so the empty set there is a real absence. It also
    // pins the deliberate asymmetry again from the get-started side: that term consults
    // no user whatsoever.
    mocks.flags = { appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: true };
    mocks.user = null;
    mocks.navSummary = undefined;
    await renderSubNav();
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });
});

/**
 * The <2-tab collapse, driven through the container. Still reachable, and by the live
 * `app-dev-testers` shape: a store-visible non-author with an empty summary and no
 * `appBlocksGetStarted` has `canBuild: false` and qualifies for Marketplace ALONE. The
 * third test is the same fixture with only that one flag moved, which is what attributes
 * the difference to the flag rather than to two unrelated fixtures.
 */
describe('AppsSubNav container — hides entirely below two tabs', () => {
  const EMPTY_SUMMARY = {
    hasInstalls: false,
    hasActivity: false,
    hasSubmissions: false,
    hasApprovedApps: false,
    isReviewer: false,
    hasEditableApps: false,
    hasPendingInvites: false,
  };

  test('a store-visible non-author with an empty summary renders no nav at all', async () => {
    mocks.isClient = true;
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderSubNav(); // barrier awaited inside — absence below is a real observation
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
    expect(renderedTabs()).toEqual([]);
  });

  test('one install is enough to bring the bar back', async () => {
    mocks.isClient = true;
    mocks.flags = { appBlocks: true, appBlocksAuthor: false };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    mocks.navSummary = { ...EMPTY_SUMMARY, hasInstalls: true };
    await renderSubNav();
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Activity']);
  });

  test('🔴 …and so is appBlocksGetStarted, on the OTHERWISE IDENTICAL viewer', async () => {
    mocks.isClient = true;
    mocks.flags = { appBlocks: true, appBlocksAuthor: false, appBlocksGetStarted: true };
    mocks.user = { id: 7, username: 'tester', isModerator: false };
    mocks.navSummary = { ...EMPTY_SUMMARY };
    await renderSubNav();
    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });
});
