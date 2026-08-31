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
  // An AUTHOR by capability (not a mod), so `Create` qualifies and the bar can
  // clear the 2-tab floor on store-visibility alone — without it, an
  // `appListings`-only viewer qualifies for Marketplace ONLY and the <2 collapse
  // would hide the bar for a reason that has nothing to do with the gate under test.
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
    await expect.element(tab('Create')).toBeInTheDocument();
  });

  test('appBlocks ONLY (appListings OFF) → still renders (the OR-fallback cohort)', async () => {
    mocks.flags = { appListings: false, appBlocks: true, appBlocksAuthor: true };
    await renderSubNav();

    await expect
      .element(page.getByRole('navigation', { name: 'App sections' }))
      .toBeInTheDocument();
    await expect.element(tab('Marketplace')).toBeInTheDocument();
    await expect.element(tab('Create')).toBeInTheDocument();
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
      'Marketplace',
      'Create',
      'Installed',
      // "My submissions" was here until its page merged into `/apps/mine`; `hasSubmissions`
      // now lights "My apps", which sits after Installed in the link table.
      'My apps',
      'Revenue',
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
    expect(renderedTabs()).toEqual(['Marketplace', 'Create']);
    expect(page.getByRole('navigation', { name: 'App sections' }).elements()).toHaveLength(1);
  });
});

/**
 * The gate is NOT the only thing that can hide the bar, and conflating the two
 * would make the tests above pass for the wrong reason. `AppsSubNavView` also
 * hides itself below two qualifying tabs. An `appListings`-only NON-author
 * qualifies for Marketplace alone, so they get no bar — correctly, via the
 * COLLAPSE rule, not via the store gate. Pinned so a future reader doesn't
 * "fix" the collapse thinking it is gate drift.
 */
describe('AppsSubNav — the <2-tab collapse is a SEPARATE rule from the gate', () => {
  test('appListings-only NON-author → no bar, by the collapse (Marketplace alone)', async () => {
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: false };
    mocks.user = { id: 8, username: 'tester', isModerator: false };
    await renderSubNav();

    expect(page.getByRole('tablist').elements()).toHaveLength(0);
    // …and the SAME viewer WITH the author capability does get a bar, which is
    // what proves the hide above came from the collapse and not from the gate.
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: true };
    await renderSubNav();
    await expect.element(tab('Create')).toBeInTheDocument();
  });

  test('a logged-out viewer gets no bar even with the store flag lit', async () => {
    mocks.flags = { appListings: true, appBlocks: false, appBlocksAuthor: true };
    mocks.user = null;
    await renderSubNav();

    expect(page.getByRole('tablist').elements()).toHaveLength(0);
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
    for (const name of ['Installed', 'My apps', 'Revenue', 'Review']) {
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
});
