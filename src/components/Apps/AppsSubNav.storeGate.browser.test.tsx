import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the
// real module's type.
import type * as TrpcMod from '~/utils/trpc';

/**
 * 🔒 `AppsSubNav` — the STORE-VISIBILITY gate, aligned with the page it sits on.
 *
 * THE DEFECT THIS PINS: the container's render gate read `features.appBlocks`
 * ALONE, while the canonical `/apps` gate (`resolveAppsPageAccess`, enforced in
 * `getServerSideProps`) grants on `appListings || appBlocks`. A cohort holding
 * `app-listings` WITHOUT `app-blocks-enabled` would therefore load `/apps`
 * successfully and get NO sub-navigation at all. Both gates now call the ONE
 * shared predicate `hasAppsStoreAccess`.
 *
 * Not reachable in production today — the current tester cohort holds BOTH flags,
 * so the two predicates agree. `app-listings` exists precisely so the catalog can
 * widen independently of the held block runtime, which is when they stop agreeing.
 *
 * 🔴 WHAT THE `/apps/build` CONSOLIDATION CHANGED IN THIS FILE. The container gate LOST
 * its `|| features.appBlocksGetStarted` term, so store access is now the whole gate; and
 * `Marketplace` stopped being an unconditional row. The observable consequence is a
 * DELIBERATE BEHAVIOUR CHANGE for one cohort — get-started WITHOUT any store flag now
 * gets no bar at all, where it used to get a two-tab one — and it has its own describe
 * block below, with the reasoning.
 *
 * ── WHY THIS FILE MOCKS `useQuery` DIFFERENTLY FROM THE HYDRATION SUITE ────────
 * The sibling `AppsSubNav.hydration.browser.test.tsx` returns `mocks.navSummary`
 * unconditionally, which is right for what it tests (the `useIsClient` deferral).
 * Here the whole question is which viewer gets which tabs, and the `enabled:` flag
 * on `blocks.getNavSummary` is load-bearing for that answer — so this mock HONOURS
 * `enabled`, exactly like the real hook. That makes the tests below faithful to
 * production AND makes the `enabled` predicate itself observable (see the last
 * describe block, which pins the deliberate decision to leave it on `appBlocks`).
 */

const ALL_TRUE_SUMMARY = {
  hasInstalls: true,
  hasSubmissions: true,
  hasApprovedApps: true,
  isReviewer: true,
  hasEditableApps: true,
  hasPendingInvites: true,
};

const mocks = vi.hoisted(() => ({
  isClient: true,
  navSummary: undefined as undefined | typeof ALL_TRUE_SUMMARY,
  flags: {} as Record<string, boolean>,
  user: null as null | { id: number; username: string; isModerator?: boolean },
  /** Every `enabled` value `getNavSummary.useQuery` was called with, in order. */
  navSummaryEnabled: [] as unknown[],
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
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    blocks: {
      getNavSummary: {
        useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
          mocks.navSummaryEnabled.push(opts?.enabled);
          // Honour `enabled` like the real hook: a disabled query never resolves,
          // so `data` stays undefined and the container falls back to EMPTY_SUMMARY.
          return { data: opts?.enabled ? mocks.navSummary : undefined };
        },
      },
    },
  },
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
 * 🔴 RENDER BARRIER — required before EVERY "renders nothing" assertion here.
 *
 * `render()` commits through a React 18 concurrent root on a LATER task, so a
 * synchronous `expect(renderedTabs()).toEqual([])` straight after
 * `renderWithProviders` reads an EMPTY container and passes no matter what the
 * component does — structurally unfailable. Render this sentinel alongside the
 * component and AWAIT it; the commit has then happened and "absent" is a real
 * observation.
 *
 * MEASURED, not assumed. Neutering the gate to a constant `true`:
 *   - WITH the awaited barrier → both "renders nothing" tests below FAIL. ✅
 *   - WITHOUT it (the `await expect.element(...)` line deleted) → both PASS,
 *     i.e. structurally unfailable.
 * Do not remove it, and do not add an absence assertion that does not sit behind
 * `renderSubNav()`.
 */
const RENDER_BARRIER = 'render-barrier';
const RenderBarrier = () => <div data-testid={RENDER_BARRIER} />;

async function renderSubNav() {
  renderWithProviders(
    <>
      <RenderBarrier />
      <AppsSubNav />
    </>
  );
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

beforeEach(() => {
  mocks.isClient = true; // post-mount, so the full tab set is observable
  mocks.navSummary = { ...ALL_TRUE_SUMMARY };
  mocks.flags = {};
  // An AUTHOR by capability (not a mod), so `canAccessAppsBuild` resolves true and the
  // bar can clear the 2-tab floor on Build + Marketplace alone — without it, an
  // `appListings`-only viewer qualifies for Marketplace ONLY and the <2 collapse would
  // hide the bar for a reason that has nothing to do with the gate under test.
  mocks.user = { id: 7, username: 'author', isModerator: false };
  mocks.navSummaryEnabled = [];
});

describe('AppsSubNav — store-visibility gate matches resolveAppsPageAccess', () => {
  test('🔴 appListings ONLY (appBlocks OFF) → the sub-nav RENDERS (the broken case)', async () => {
    // The cohort the canonical gate admits to /apps but the old sub-nav gate turned
    // away. Reverting the container to `if (!features.appBlocks) return null` fails
    // HERE, on this assertion.
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: true };
    await renderSubNav();

    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Build')).toBeInTheDocument();
  });

  test('appBlocks ONLY (appListings OFF) → still renders (the OR-fallback cohort)', async () => {
    mocks.flags = { appListings: false, appBlocks: true, appBlocksAuthor: true };
    await renderSubNav();

    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Build')).toBeInTheDocument();
  });

  test('BOTH flags true → renders (today’s live cohort — unchanged behaviour)', async () => {
    mocks.flags = { appListings: true, appBlocks: true, appBlocksAuthor: true };
    await renderSubNav();

    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    // With `appBlocks` on, the summary query is enabled, so the conditional tabs
    // resolve too — the full bar today's testers actually see.
    await expect.element(tab('Review')).toBeInTheDocument();
    expect(renderedTabs()).toEqual([
      // "Build apps"/"Create"/"My apps" collapsed into this ONE row (`/apps/build`); the
      // first two retired routes 301 there and `/apps/submit` kept its route without a
      // tab. `hasSubmissions`/`hasEditableApps` are true in this summary and light
      // nothing, which is the property that keeps the row hydration-safe.
      'Marketplace',
      'Activity',
      'Invites',
      'Revenue',
      'Build',
      'Review',
    ]);
  });

  test('NEITHER flag → renders NOTHING (the gate is still a gate)', async () => {
    mocks.flags = { appListings: false, appBlocks: false, appBlocksAuthor: true };
    await renderSubNav(); // barrier awaited inside — absence below is a real observation

    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('tablist').elements()).toHaveLength(0);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  test('flags ABSENT entirely (Flipt down / not yet created) → renders nothing (fails closed)', async () => {
    mocks.flags = { appBlocksAuthor: true };
    await renderSubNav();

    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });

  // 🔴 POSITIVE CONTROL for the two `toEqual([])` assertions above. If
  // `renderedTabs()` / the role queries were wired to nothing they would report an
  // empty set for EVERY input, and both absence tests would be vacuously green.
  test('POSITIVE CONTROL: the same readers DO observe a bar when the gate opens', async () => {
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: true };
    await renderSubNav();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(1);
  });
});

/**
 * 🔴 MARKETPLACE IS GATED ON STORE ACCESS NOW — THE 404 EXPOSURE THIS CHANGE CLOSED,
 * DRIVEN THROUGH THE CONTAINER.
 *
 * The row was `visible: () => true` while `/apps` gates on `resolveAppsPageAccess`, a
 * documented and deliberately-unfixed mismatch: closing it used to drop the
 * get-started-only cohort to one tab, where the collapse deletes the bar. At the
 * container level the fix is now belt-and-braces, and BOTH belts are asserted here
 * because they fail differently:
 *   1. the container returns `null` for a viewer with no store access, so there is no bar;
 *   2. the row itself keys on `c.canSeeStore`, so even if the container gate were
 *      widened again the tab would not come back.
 * Test 2 is what a reviewer would otherwise call redundant — it is the one that still
 * fails if someone "restores" the `|| features.appBlocksGetStarted` term to the gate.
 */
describe('AppsSubNav — no store access ⇒ no Marketplace tab, by two independent gates', () => {
  test('🔴 no store flags at all → no bar (the container gate)', async () => {
    mocks.flags = { appBlocks: false, appListings: false, appBlocksAuthor: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
    await renderSubNav(); // barrier awaited inside — absence below is a real observation

    expect(renderedTabs()).toEqual([]);
    expect(tab('Marketplace').elements()).toHaveLength(0);
  });

  test('🔴 DISCRIMINATING CONTROL: one store flag flips the SAME viewer to a bar with Marketplace', async () => {
    // Only `appListings` moves. Without this arm the absence above would be satisfied by
    // a component that renders nothing for anyone.
    mocks.flags = { appBlocks: false, appListings: true, appBlocksAuthor: true };
    mocks.user = { id: 7, username: 'author', isModerator: false };
    await renderSubNav();

    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(tab('Marketplace').element().getAttribute('href')).toBe('/apps');
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });

  test('🔴 the external-only cohort is admitted too (appListingsPublicExternal)', async () => {
    // The third disjunct of `hasAppsStoreAccess`. It is REACHABILITY only — the server's
    // `StoreVisibilityScope` decides what they actually see — but if this gate refused
    // them, `/apps` would be structurally unreachable for a catalog the server would
    // happily serve. A MOD is used so `canBuild` supplies the second tab: `appBlocks` is
    // off here, so the summary query is disabled and cannot supply one, and a bar of one
    // tab would collapse and tell us nothing about the Marketplace row.
    mocks.flags = { appBlocks: false, appListings: false, appListingsPublicExternal: true };
    mocks.user = { id: 1, username: 'mod', isModerator: true }; // mod ⇒ canBuild
    await renderSubNav();

    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });
});

/**
 * 🔴 THE <2-TAB COLLAPSE, DRIVEN THROUGH THE CONTAINER — UNCHANGED FROM `main` FOR
 * EVERY COHORT THAT CANNOT BUILD.
 *
 * An `appListings`-only non-author (and a logged-out viewer with no capability)
 * qualifies for Marketplace ALONE and the collapse drops the whole bar. "Build" is gated
 * on `context.canBuild` = `canAccessAppsBuild`, so it does NOT lift these cohorts over
 * the floor — which is the point: `/apps/build` `notFound`s them, so a tab into it would
 * be a tab into a 404. Pinned here so a later widening of that predicate is visible in a
 * diff rather than discovered on staging.
 */
describe('AppsSubNav — the collapse still hides the bar for a one-tab viewer', () => {
  test('🔴 appListings-only NON-author, no get-started → no bar at all', async () => {
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: false };
    mocks.user = { id: 8, username: 'tester', isModerator: false };
    await renderSubNav(); // barrier awaited inside — absence below is a real observation

    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
    // …and the SAME viewer WITH the author capability DOES get a bar, which is what
    // proves the absence above came from the predicates and not from a stuck render.
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: true };
    await renderSubNav();
    await expect.element(tab('Build')).toBeInTheDocument();
  });

  test('🔴 …and the get-started capability is what lifts that same viewer over the floor', async () => {
    // Identical to the first arm above except for ONE flag. Making "Build"
    // unconditional makes the first arm fail; removing the tab makes this one fail.
    mocks.flags = {
      appListings: true,
      appBlocks: false,
      appBlocksAuthor: false,
      appBlocksGetStarted: true,
    };
    mocks.user = { id: 8, username: 'tester', isModerator: false };
    await renderSubNav();

    await expect.element(tab('Build')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });

  test('a logged-out viewer with the store flag and no build capability gets no bar', async () => {
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: false };
    mocks.user = null;
    await renderSubNav();

    // No capability term holds, so `canBuild` is false and Marketplace is all that
    // qualifies — the collapse then removes the bar. (The summary query is disabled for
    // an anon viewer anyway; that half is pinned in the last describe.)
    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });
});

/**
 * 🔴 THE CONTAINER GATE IS `hasAppsStoreAccess` ALONE — THE `|| appBlocksGetStarted` TERM
 * IS GONE, AND ONE COHORT'S BEHAVIOUR DELIBERATELY CHANGED.
 *
 * WHAT IT USED TO DO: the bar carried a "Build apps" tab pointing at `/apps/get-started`,
 * whose own gate (`resolveGetStartedAccess`) was `appBlocksGetStarted` ALONE and consulted
 * no store flag. A store-less holder of that flag could genuinely load that page, so the
 * gate carried a second term to let them see the tab.
 *
 * WHY IT IS GONE, AND WHY THAT IS A NO-OP RATHER THAN A REGRESSION: `/apps/get-started` no
 * longer exists (it 301s to `/apps/build`), and `/apps/build`'s gate —
 * `canAccessAppsBuild` — has `hasAppsStoreAccess` as a HARD AND. So this cohort has no
 * `/apps/*` destination at all now:
 *   • Build       — `canBuild` is false without store access;
 *   • Marketplace — `canSeeStore` is false, and `/apps` would 404 them anyway (that tab
 *                   was the KNOWN exposure this change closed);
 *   • Installed / Invites / Revenue / Review — driven by `getNavSummary`, whose `enabled`
 *                   requires `appBlocks`, itself one of the store disjuncts.
 * Every row is unreachable for them, so the `< 2` collapse would return `null` a moment
 * later regardless — the gate just gets there first. The old bar was two tabs into two
 * pages they could not load.
 *
 * ⚠️ THE JUSTIFICATION FOR KEEPING THE TERM WAS DRAFTED AND WAS WRONG — recorded because
 * it is the plausible-sounding reason someone will re-add it: "Invites keys on
 * `c.isAuthor`, so an author with no store flags would lose their invite tab." That
 * author does not HAVE an invite tab — `hasPendingInvites` comes from a query gated on
 * `appBlocks`, so it is false for them either way.
 */
describe('AppsSubNav — the container gate is store access ALONE (the get-started term is gone)', () => {
  test('🔴 BEHAVIOUR CHANGE: appBlocksGetStarted ONLY (no store flag) → NO BAR AT ALL', async () => {
    // Before the consolidation this exact viewer got a two-tab bar
    // (["Build apps", "Marketplace"]). Restoring `|| features.appBlocksGetStarted` to the
    // container gate fails HERE.
    mocks.flags = { appBlocksGetStarted: true, appListings: false, appBlocks: false };
    mocks.user = { id: 9, username: 'builder', isModerator: false };
    await renderSubNav(); // barrier awaited inside — absence below is a real observation

    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
    expect(tab('Build').elements()).toHaveLength(0);
    expect(tab('Marketplace').elements()).toHaveLength(0);
  });

  test('🔴 DISCRIMINATING CONTROL: add a store flag to that same viewer and the bar appears', async () => {
    // ONE flag moves. This is what makes the absence above attributable to the store gate
    // rather than to the get-started flag being ignored altogether — and it is also the
    // proof that `canBuild`'s get-started disjunct still works, since this viewer is a
    // non-author whose ONLY route to `/apps/build` is that term.
    mocks.flags = { appBlocksGetStarted: true, appListings: true, appBlocks: false };
    mocks.user = { id: 9, username: 'builder', isModerator: false };
    await renderSubNav();

    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    await expect.element(tab('Build')).toBeInTheDocument();
    expect(tab('Build').element().getAttribute('href')).toBe('/apps/build');
    // Non-author, `appBlocks` off ⇒ summary query disabled ⇒ exactly the two frozen tabs.
    expect(renderedTabs()).toEqual(['Marketplace', 'Build']);
  });

  test('🔴 store access but NO build capability → a bar with NO Build tab', async () => {
    // The mirror of the control above, and the one the ROW predicate exists for: this
    // viewer holds a store flag (so the gate admits them) but neither capability term, so
    // `/apps/build` answers `notFound` for them and the tab must be absent. Given ONE
    // install so the bar clears the `< 2` floor — this is an assertion about the TAB
    // rather than about the bar.
    mocks.flags = {
      appListings: false,
      appBlocks: true,
      appBlocksAuthor: false,
      appBlocksGetStarted: false,
    };
    mocks.user = { id: 8, username: 'tester', isModerator: false };
    mocks.navSummary = {
      ...ALL_TRUE_SUMMARY,
      hasSubmissions: false,
      hasApprovedApps: false,
      isReviewer: false,
      hasEditableApps: false,
      hasPendingInvites: false,
    };
    await renderSubNav();

    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    expect(renderedTabs()).toEqual(['Marketplace', 'Activity']);
    expect(tab('Build').elements()).toHaveLength(0);
  });

  test('NEITHER store access NOR appBlocksGetStarted → no bar (the gate is still a gate)', async () => {
    mocks.flags = { appListings: false, appBlocks: false, appBlocksGetStarted: false };
    mocks.user = { id: 9, username: 'nobody', isModerator: false };
    await renderSubNav(); // barrier awaited inside — absence below is a real observation

    expect(renderedTabs()).toEqual([]);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(0);
  });
});

/**
 * 🔴 THE `enabled:` PREDICATE ON `blocks.getNavSummary` IS DELIBERATELY *NOT*
 * THE STORE PREDICATE — pinned so the two are not "aligned" by a later reader
 * who assumes every flag read in this file must move together.
 *
 * A query gate mirrors the gate on the PROCEDURE it calls, not the gate on the
 * page it renders in. `getNavSummary` is `protectedProcedure.use(enforceAppBlocksFlag)`
 * — the strict `app-blocks-enabled` check — and because it is a QUERY the
 * middleware short-circuits to the ALL-FALSE summary instead of throwing. So for
 * an `appListings`-only viewer, widening this `enabled` buys a guaranteed
 * round-trip to a guaranteed all-false answer; and all-false is ALSO the correct
 * tab set, because every conditional tab points at a page that itself 404s
 * without `appBlocks`.
 */
describe('AppsSubNav — the getNavSummary query gate stays on appBlocks', () => {
  test('appListings-only: the summary query is DISABLED and no conditional tab renders', async () => {
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: true };
    await renderSubNav();

    await expect.element(tab('Marketplace')).toBeInTheDocument();
    expect(mocks.navSummaryEnabled.length).toBeGreaterThan(0); // the hook did run
    expect(mocks.navSummaryEnabled.every((e) => e === false)).toBe(true);
    for (const name of ['Activity', 'Invites', 'Revenue', 'Review']) {
      expect(tab(name).elements()).toHaveLength(0);
    }
  });

  test('appBlocks on + logged in: the summary query IS enabled (positive control)', async () => {
    mocks.flags = { appListings: false, appBlocks: true, appBlocksAuthor: true };
    await renderSubNav();

    await expect.element(tab('Review')).toBeInTheDocument();
    expect(mocks.navSummaryEnabled.some((e) => e === true)).toBe(true);
  });

  test('appBlocks on but LOGGED OUT: still disabled (the protectedProcedure half)', async () => {
    mocks.flags = { appListings: false, appBlocks: true, appBlocksAuthor: true };
    mocks.user = null;
    await renderSubNav();

    expect(mocks.navSummaryEnabled.every((e) => e === false)).toBe(true);
  });

  test('🔴 the get-started cohort does NOT enable the query — the hook still runs before the gate', async () => {
    // Two claims, and the second is the non-obvious one. (a) Widening the BAR gate must
    // never widen the QUERY gate; the term is gone now, but the hook is still called for
    // this viewer because `useQuery` runs ABOVE the `return null` — React would break the
    // rules of hooks otherwise — so `enabled` is the only thing keeping the round-trip
    // from happening. (b) That is why `navSummaryEnabled` is non-empty here at all
    // despite the container rendering nothing; asserting the count first is what stops
    // `every(... === false)` from passing vacuously over an empty array.
    mocks.flags = { appBlocksGetStarted: true, appListings: false, appBlocks: false };
    mocks.user = { id: 9, username: 'builder', isModerator: false };
    await renderSubNav();

    expect(renderedTabs()).toEqual([]); // the store gate returned null
    expect(mocks.navSummaryEnabled.length).toBeGreaterThan(0); // …but the hook did run
    expect(mocks.navSummaryEnabled.every((e) => e === false)).toBe(true);
  });
});
