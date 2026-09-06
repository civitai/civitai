import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * P2b AppListingsMarketplaceBody wiring tests (REPORT-ONLY). Network-free — the
 * P2a `appListings.listAvailable` infinite query + feature flags are mocked.
 * Covers the kind filter passing through to the query args, the sort/category
 * controls rendering, and the card grid rendering the returned listings.
 */

function makeCard(id: string, name: string, kind: 'onsite' | 'offsite' = 'onsite'): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind,
    name,
    tagline: 'tag',
    category: null,
    contentRating: null,
    isBeta: false,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    openCount: kind === 'onsite' ? 0 : null,
    kindData:
      kind === 'onsite'
        ? {
            kind: 'onsite',
            appBlockId: `blk-${id}`,
            hasPage: false,
            liveUrl: `https://slug-${id}.civit.ai`,
          }
        : { kind: 'offsite', externalUrl: 'https://x.app' },
  };
}

const mocks = vi.hoisted(() => ({
  items: [] as ListingCard[],
  lastArgs: null as null | Record<string, unknown>,
}));

// The grid renders AppListingCard, which calls useCurrentUser() (owner "Edit"
// deep-link gate, added in #3392). Without a mock it hits the real
// CivitaiSessionContext — absent in the provider stack — and throws "missing
// CivitaiSessionContext", crashing every card render. Mock a signed-out viewer.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

/**
 * This suite mounts ANONYMOUSLY (the mock above), and recents are ACCOUNT-scoped
 * (#4048) with `null` — signed out — as its own bucket, not a wildcard. Seeds
 * must therefore be written as `null`, or the body reads an empty rail.
 */
const SESSION_OWNER_ID: number | null = null;

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock): a hand-written replacement silently breaks every importer the
// day '~/utils/trpc' grows an export this factory omits — the whole FILE then
// fails to load with 0 tests collected and no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: {
        useInfiniteQuery: (input: Record<string, unknown>) => {
          mocks.lastArgs = input;
          return {
            data: { pages: [{ items: mocks.items, nextCursor: undefined }] },
            isLoading: false,
            isFetchingNextPage: false,
            fetchNextPage: vi.fn(),
            hasNextPage: false,
          };
        },
      },
    },
  },
}));

// 🔴 THE WHOLESALE FACTORY MUST NAME **BOTH** FLAG HOOKS.
// It replaces the module outright, so a named import in the file's module graph that
// the factory omits makes the whole file fail to IMPORT — reported as
// `Tests no tests`, i.e. as nothing to see rather than as a failure. That is exactly
// what happened when the store card began rendering the shared `⋮` menu, whose
// `useCanReviewListing` reads `useOptionalFeatureFlags`.
// 🔴 AN `importOriginal` SPREAD IS THE WRONG CURE HERE, and it was tried: the real
// flags module imports `setTrpcBatchingEnabled` from `~/utils/trpc`, which this
// file's own wholesale trpc factory does not provide, so spreading moves the same
// import failure one module over. See
// `src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts`, which
// gates exactly this rule for its own directory.
// Both hooks must return the SAME flags: a component may call either, and which one
// it calls is not something a test file can see.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
}));

// The filters now live in the shared `AdaptiveFiltersDropdown`, which pulls in two
// providers the component harness does not mount and which THROW rather than
// returning a default:
//  - `useIsClient()` throws "missing IsClientContext" (it gates the count Indicator);
//  - `useIsMobile()` -> `useContainerQuery` -> `useContainerContext()` throws without a
//    ContainerProvider (it picks the desktop popover vs the mobile drawer).
// Unmocked, either takes the whole body down with an empty <body> and every assertion
// below fails by burning its timeout. `isClient: true` = post-hydration (so the count
// badge renders); `mobile: false` = the desktop popover path. The mobile drawer path
// and the pre-hydration path get their own files.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));

// Import AFTER mocks (vi.mock is hoisted, static imports are not).
const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');
const { clearRecentlyOpenedApps, recordRecentlyOpenedApp } = await import(
  './recentlyOpenedAppsStore'
);

/**
 * The scaffold's SHARED router singleton. A per-file `vi.mock('next/router')`
 * SILENTLY LOSES to the setup-file mock in `test/component-setup.tsx` (documented
 * the hard way in `AppEditPage.browser.test.tsx`, where `?tab=` could never be
 * seeded) — so seed `router.query` on the shared object instead.
 *
 * The store's filters now live in the URL, which splits every filter assertion in
 * two: seeding `router.query` covers the READ, and inspecting `router.replace`
 * covers the WRITE. The harness's `replace` is an inert `vi.fn()` — it does not
 * feed the new query back into `router.query` and could not re-render if it did —
 * so a single test that clicks a toggle and then reads the tRPC args would assert
 * the OLD value and pass for the wrong reason. Keep the two halves separate.
 */
// NOTE the disable is the LAST comment line before the statement — an
// `eslint-disable-next-line` followed by MORE comment lines disables the next
// COMMENT, not the code, and silently does nothing.
//
// Not a real hook: the scaffold mocks `next/router` with `useRouter: () => router`,
// a plain function returning a singleton, so module-scope is fine (and is the
// established idiom — a per-file `vi.mock` silently loses to the setup-file mock;
// see AppEditPage.browser.test.tsx).
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

beforeEach(() => {
  mocks.items = [makeCard('a', 'Alpha App'), makeCard('b', 'Bravo App', 'offsite')];
  mocks.lastArgs = null;
  // A FRESH object each test: `useZodRouteParams` memoises on the `query`
  // reference, so mutating the previous object in place would be invisible.
  router.query = {};
  vi.mocked(router.replace).mockClear();
  clearRecentlyOpenedApps();
});

/**
 * Captured BEFORE any `vi.useFakeTimers()` call so the virtual-clock helper can
 * still yield a REAL macrotask while virtual time stands still — `setTimeout` is
 * faked inside the test, so the obvious `new Promise((r) => setTimeout(r, 0))`
 * would never resolve.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * 🔴 The virtual clock must never escape a test. A `finally` inside the test body
 * does NOT run when a test TIMES OUT (the awaited promise never settles) — and a
 * timer test is exactly where that happens — which would leave every subsequent
 * test in this file on a frozen clock. Same leak, same fix as
 * `src/server/services/blocks/__tests__/app-views.service.test.ts`.
 *
 * Vitest runs `afterEach` hooks in reverse registration order, so this runs
 * BEFORE the setup file's `await cleanup()` — the unmount never sees a frozen
 * clock either.
 *
 * MEASURED, so nobody re-derives it: the leak is REAL but its consequence here
 * is currently benign. Delete this hook and `vi.isFakeTimers()` is `true` at the
 * top of the very next test (probed, red); every test in the file nonetheless
 * still passes, because none of the ones that follow depends on `setTimeout`.
 * So this is a preventative invariant, NOT a regression guard — it is what
 * stands between an unexplainable hang and the day a later test grows a timer
 * dependency.
 */
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Install the virtual clock, restricted to the timer functions.
 *
 * `Date`, `performance`, `requestAnimationFrame`, `queueMicrotask` and
 * `MessageChannel` stay REAL, so React's scheduler, Mantine and the Playwright
 * driver behave exactly as they do under real timers. The only thing that
 * becomes virtual is how long a `setTimeout` takes to fire — which is precisely
 * the 300ms `useDebouncedValue` under test. (Same restriction, same reason as
 * `src/components/AppBlocks/PageBlockHostAutoRetry.browser.test.tsx`.)
 */
function useVirtualClock() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
}

/**
 * Move virtual time forward by exactly `ms`, then let React commit whatever the
 * fired timers scheduled. `advance(0)` is therefore also the "flush pending
 * renders + effects" primitive: it fires nothing, it only drains the queues.
 *
 * The real-macrotask yield is load-bearing — advancing virtual time alone gives
 * the page only microtasks, so a passive effect scheduled on React's
 * MessageChannel would not have run by the time the next assertion reads
 * `router.replace`.
 */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

/** Open the collapsed Filters dropdown — kind/category live inside it now. */
async function openFilters() {
  await userEvent.click(page.getByRole('button', { name: 'Filters' }));
  await expect.element(page.getByTestId('apps-store-filters-panel')).toBeInTheDocument();
}

describe('AppListingsMarketplaceBody', () => {
  test('renders the returned listings as cards + the inline search/sort controls', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    await expect.element(page.getByText('Bravo App')).toBeInTheDocument();
    // Search + sort stay INLINE (not behind the Filters button), and both still
    // have an accessible name after their VISIBLE labels were dropped for the
    // single-row layout — the icon + placeholder are not an accessible name.
    // (Mantine's `Select` mirrors `aria-label` onto BOTH the input and its
    // listbox, hence `.first()`: the input is the control under test.)
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    await expect.element(page.getByLabelText('Sort').first()).toHaveValue('Top rated');
    // Kind filter is now inside the dropdown, defaulting to All.
    await openFilters();
    await expect
      .element(page.getByRole('button', { name: 'All apps' }))
      .toHaveAttribute('aria-pressed', 'true');
    // Query fired with kind=all default. `limit: 48` (was 24) — the column ladder now
    // reaches FIVE columns on a 2560 container, where 24 is under five rows; the page
    // size and its relationship to the server's `max(50)` cap are pinned in the blocking
    // unit suite (`__tests__/appListingGrid.test.ts`).
    // ⚠️ This said "SIX columns … only four rows" until the card-width floor moved 383 →
    // 460 in this same PR and made six unreachable. Written true, falsified by a later
    // commit on the same branch.
    expect(mocks.lastArgs).toMatchObject({ kind: 'all', sort: 'top-rated', limit: 48 });
  });

  test('clicking a kind toggle WRITES kind to the URL (shallow, no scroll)', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await openFilters();
    await userEvent.click(page.getByRole('button', { name: 'Standalone' }));

    expect(router.replace).toHaveBeenCalled();
    const [url, , options] = vi.mocked(router.replace).mock.calls.at(-1)!;
    expect(url).toMatchObject({ query: { kind: 'offsite' } });
    // Shallow so the filter change doesn't re-run getServerSideProps, and
    // scroll:false so it doesn't jump the viewport mid-browse.
    expect(options).toMatchObject({ shallow: true, scroll: false });
  });

  test('a param-seeded mount drives the tRPC query from the URL (the shareable-link path)', async () => {
    router.query = { kind: 'offsite', category: 'generation', sort: 'newest' };
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    expect(mocks.lastArgs).toMatchObject({
      kind: 'offsite',
      category: 'generation',
      sort: 'newest',
    });
  });

  /** Every `router.replace` call's resulting query object, oldest-first. */
  function replacedQueries(): Record<string, unknown>[] {
    return vi
      .mocked(router.replace)
      .mock.calls.map(([url]) => (url as { query?: Record<string, unknown> }).query ?? {});
  }

  /** The subset of `router.replace` calls that wrote the search term. */
  function searchWrites(): Record<string, unknown>[] {
    return replacedQueries().filter((q) => 'query' in q);
  }

  test('🔴 the search box does NOT write the URL per keystroke — only the debounced value', async () => {
    /**
     * 🔴 THE CLOCK IS VIRTUAL, THE BEHAVIOUR IS NOT.
     *
     * This test used to RACE the fills against the 300ms debounce: it typed, then
     * asserted zero writes, and was correct only while the typing finished inside
     * the window. The margin was never as wide as the old comment assumed. An
     * earlier six-fill version took ~396ms against the 300ms budget and was cut to
     * two fills to buy room; the two-fill version then measured 338ms end-to-end
     * on an unrelated branch, and it went RED on civitai#3627's preview run
     * (1 failed / 1258 passed of 1259) ten minutes after a sibling PR ran the same
     * code 1259/1259 green. Machine load, not a regression — a red nobody can act
     * on. Instrumented here, `fill()` alone measured 41–142ms per call across five
     * consecutive runs on an IDLE box: a 3.4x spread with nothing competing, which
     * is why widening the margin was never going to hold.
     *
     * Freezing `setTimeout` removes the dependency outright. The fills now take as
     * long as the runner needs and virtual time does not move while they do, so
     * the debounce cannot elapse mid-typing however slow the box is. Nothing about
     * the component changes: the same `useDebouncedValue` arms the same
     * `setTimeout`, the same effect echoes it into the URL.
     */
    useVirtualClock();

    renderWithProviders(<AppListingsMarketplaceBody />);
    const search = page.getByLabelText('Search');

    // TWO fills, because two is what distinguishes the regression: a box wired
    // straight through to the URL writes once PER keystroke (2 here), a debounced
    // one writes 0 until the timer fires. More fills would prove nothing extra.
    await search.fill('mat');
    await search.fill('matrix');

    // Drain React's render/effect queues so the debounce timer is definitely
    // ARMED before any of the boundary assertions below read the clock. Without
    // this the "not yet" assertions could pass because nothing was scheduled yet.
    await advance(0);

    // (1) THE GUARD. Zero writes from the typing itself — this is the assertion
    // that fails if the input is wired straight through to the URL (it would be
    // 2). It no longer depends on how fast `fill()` ran.
    expect(searchWrites()).toHaveLength(0);

    // (2) NEGATIVE half of the control: 1ms BEFORE the debounce elapses, still
    // nothing. Pins that the write is actually gated on the 300ms window rather
    // than merely arriving late.
    await advance(299);
    expect(searchWrites()).toHaveLength(0);

    // (3) POSITIVE half: crossing 300ms produces exactly ONE write, carrying the
    // FINAL value. Without this half (1) and (2) would both be satisfied by a
    // search box that never writes the URL at all.
    await advance(1);
    const writes = searchWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ query: 'matrix' });
  });

  test('a `?query=` param seeds the search box and filters the grid', async () => {
    router.query = { query: 'Alpha' };
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toHaveValue('Alpha');
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    // Bravo is filtered out client-side by the seeded query.
    expect(page.getByText('Bravo App').elements()).toHaveLength(0);
  });

  test('sorting writes the sort param', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await userEvent.click(page.getByLabelText('Sort').first());
    await userEvent.click(page.getByRole('option', { name: 'Newest' }));
    expect(replacedQueries().at(-1)).toMatchObject({ sort: 'newest' });
  });

  test('a DEFAULT value is stripped from the URL rather than written as noise', async () => {
    router.query = { kind: 'offsite' };
    renderWithProviders(<AppListingsMarketplaceBody />);
    await openFilters();
    await userEvent.click(page.getByRole('button', { name: 'All apps' }));
    // `?kind=all` is the default view — a nav that lands on
    // `/apps?kind=all&sort=top-rated` looks like state you have to clear.
    expect(replacedQueries().at(-1)).not.toHaveProperty('kind');
  });

  test('empty result → "No apps yet"', async () => {
    mocks.items = [];
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('No apps yet')).toBeInTheDocument();
  });

  // ── The grid's STRUCTURE ────────────────────────────────────────────────────
  // 🔴 THE COLUMN COUNTS MOVED OUT OF THIS FILE, DELIBERATELY. The grid used to be a
  // Mantine `<Grid>`/`<Grid.Col span={LISTING_GRID_SPAN}>`, which compiled the whole
  // responsive ladder into a generated `--col-flex-basis` <style> block — so the span
  // was assertable from the CSSOM without any stylesheet being loaded. It is now a CSS
  // grid whose column count comes from a CONTAINER QUERY in
  // `AppListingsMarketplaceBody.module.scss`, and this file's tier deliberately loads
  // no app cascade (see `test/component-setup.tsx`), so a `grid-template-columns`
  // assertion here would be reading the UA default and passing on an unstyled element.
  //
  // The rendered counts are therefore measured in
  // `AppListingsMarketplaceBody.columns.browser.test.tsx`, which imports the cascade
  // itself; the ladder's numbers and its agreement with the stylesheet are pinned in
  // the blocking unit suite (`__tests__/appListingGrid.test.ts`). What is left HERE is
  // the structure those two both assume: one cell per card, each carrying the testid,
  // inside the grid, inside the query container.
  test('the grid renders one testid-carrying cell per card, nested inside the query container', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();

    const cols = page.getByTestId('apps-listing-grid-col').elements();
    expect(cols).toHaveLength(mocks.items.length);

    const grid = page.getByTestId('apps-listing-grid').element();
    // Every cell is a DIRECT child of the grid. Load-bearing rather than pedantic: a
    // CSS grid only lays out its own children, so a cell one wrapper deeper would be
    // laid out by the wrapper and the column count would silently become 1 — with
    // `grid-template-columns` still reading exactly right in the CSSOM.
    for (const col of cols) expect(col.parentElement).toBe(grid);
    // …and the grid sits inside a container element, which is what `@container`
    // resolves against. `container-type` on the grid itself would match nothing.
    expect(grid.parentElement).not.toBeNull();
    expect(grid.parentElement).not.toBe(grid);
  });

  // ── "Recently opened" rail ──────────────────────────────────────────────────
  // Selection/target logic is pinned in the CI-run node unit suite
  // (__tests__/recentAppsRail.test.ts). What these assert is the WIRING: the
  // page really reads the store after mount, really renders the rail BELOW the
  // search/filter controls but ABOVE the result grid, and really renders NOTHING
  // for a viewer with no recents.

  test('a viewer with NO recents sees no rail at all (no heading, no reserved space)', async () => {
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    expect(page.getByTestId('apps-recent-rail').elements()).toHaveLength(0);
    expect(page.getByText('Recently opened').elements()).toHaveLength(0);
  });

  test('🔴 a viewer WITH recents sees the rail BELOW the controls and ABOVE the grid (CLS)', async () => {
    recordRecentlyOpenedApp(
      {
        id: 'ab_1',
        blockId: 'gen-matrix',
        slug: 'gen-matrix',
        kind: 'onsite',
        hasPage: true,
        name: 'Gen Matrix',
      },
      SESSION_OWNER_ID
    );
    renderWithProviders(<AppListingsMarketplaceBody />);

    const rail = page.getByTestId('apps-recent-rail');
    await expect.element(rail).toBeInTheDocument();
    await expect.element(page.getByText('Gen Matrix')).toBeInTheDocument();

    // Document order, asserted on BOTH sides — `compareDocumentPosition` is the
    // direct encoding of position, where a visual-only check would pass with the
    // rail appended at the bottom like the legacy body did.
    const railEl = rail.element();
    const search = page.getByLabelText('Search').element();
    const firstCard = page.getByTestId('apps-listing-grid-col').elements()[0];

    // 1. The rail comes AFTER the search input. The rail hydrates one frame late
    //    (localStorage is client-only), so placing it above the primary controls
    //    shifted them down by ~90px after paint — a CLS regression Faro RUM
    //    reports for this page. Below the controls, the late insertion only moves
    //    the grid.
    expect(search.compareDocumentPosition(railEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 2. …but still BEFORE the first result card, so "jump back in" outranks
    //    browsing and stays above the fold.
    expect(
      railEl.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('a LEGACY {id, blockId} recents entry still renders (resolved, not dropped)', async () => {
    recordRecentlyOpenedApp({ id: 'ab_legacy', blockId: 'legacy-app' }, SESSION_OWNER_ID);
    renderWithProviders(<AppListingsMarketplaceBody />);
    const item = page.getByTestId('apps-recent-rail-item');
    await expect.element(item).toBeInTheDocument();
    // hasPage unknown for a legacy entry → the always-valid detail link.
    await expect.element(item).toHaveAttribute('href', '/apps/store-preview/legacy-app');
  });
});
