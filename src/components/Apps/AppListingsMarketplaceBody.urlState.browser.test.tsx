import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * `/apps` store URL state — the tests that need a router that ACTUALLY ROUND-TRIPS.
 *
 * 🔴 WHY THIS FILE EXISTS. The shared scaffold mocks `next/router` with an inert
 * `replace: vi.fn()`: it records the call and never feeds the new query back into
 * `router.query`, and nothing re-renders. Every other test in this PR is written
 * against that — which is fine for "did we write the right param", and is exactly
 * why two real bugs were unreachable:
 *
 *   (a) the search box goes STALE when `router.query` changes while mounted
 *       (browser Back). The box seeds once from `useState(filters.query)`, so it
 *       keeps showing the old term while the URL says otherwise — and the grid
 *       keeps FILTERING by it, because `filteredItems` reads the box, not the URL.
 *
 *   (b) two fast filter clicks DROP one. `useZodRouteParams` builds each write as
 *       `schema.parse({ ...query, ...params })` where `query` is memoised on
 *       `router.query`, and `router.replace` is async. A second click inside the
 *       first replace's in-flight window merges against the STALE snapshot, so
 *       the first selection vanishes from the URL — and since the panel now
 *       renders FROM the URL, it visually reverts. This is a NEW failure mode
 *       introduced by moving the filters off `useState`.
 *
 * Both are reproduced here BEFORE being fixed; see the commit for the red/green.
 *
 * 🔴 The fix for (b) stays LOCAL to `useAppsStoreQueryParams`. `useZodRouteParams`
 * is shared with `/models` and is not touched.
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

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));
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

const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');

// NOTE the disable is the LAST comment line before the statement — an
// `eslint-disable-next-line` followed by MORE comment lines disables the next
// COMMENT, not the code, and silently does nothing.
//
// Not a real hook: the scaffold mocks `next/router` with `useRouter: () => router`,
// a plain function returning a singleton, so module-scope is fine (and is the
// established idiom — a per-file `vi.mock` silently loses to the setup-file mock).
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

/**
 * Router latency for the race tests.
 *
 * 🔴 CALIBRATED, not guessed. The window has to be longer than the gap between
 * two AWAITED `userEvent.click()` calls, because each click waits for
 * actionability and dispatch before resolving. At 50ms the second click landed
 * AFTER the first write had already applied, so the race simply did not happen
 * and the test passed against the unfixed code — a false green that would have
 * shipped this as "already fine". 500ms is comfortably longer than a click.
 */
const ROUTER_LATENCY_MS = 500;

/** Lets a test push a query change from OUTSIDE the component (Back/forward). */
let forceRerender: (() => void) | null = null;

/**
 * Every `router.replace` the component issues, counted.
 *
 * 🔴 THE ONLY ASSERTION THAT CAN SEE THE PING-PONG. Every other check in this
 * file is a RETRYING matcher (`vi.waitFor`, `expect.element(...).toHaveValue`),
 * and a retrying matcher passes the moment the oscillation happens to swing
 * through the expected value. The whole suite was green on the unfixed code
 * while `/apps` burned ~1.8 route writes/sec forever in production. A COUNT that
 * must stop growing is the shape of assertion the defect cannot satisfy.
 */
let replaceCalls = 0;

/**
 * A router that behaves like the real one: `replace` applies the new query AFTER
 * a delay and then re-renders the subscribers, and it returns a promise.
 *
 * `latencyMs` is the whole point. At 0 the two-click race cannot happen because
 * the first write lands before the second click; the real `router.replace` is
 * async, so the in-flight window is real.
 */
function StatefulRouterHarness({ latencyMs }: { latencyMs: number }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    forceRerender = force;
    const original = router.replace;
    router.replace = ((url: unknown) => {
      replaceCalls += 1;
      const nextQuery = { ...((url as { query?: Record<string, unknown> })?.query ?? {}) };
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          // A FRESH object — `useZodRouteParams` memoises on the query
          // REFERENCE, so mutating in place would be invisible.
          router.query = nextQuery as typeof router.query;
          force();
          resolve(true);
        }, latencyMs);
      });
    }) as typeof router.replace;
    return () => {
      router.replace = original;
      forceRerender = null;
    };
  }, [latencyMs]);

  return <AppListingsMarketplaceBody />;
}

/** Simulate a browser Back / an external navigation to `next`. */
function navigateTo(next: Record<string, string>) {
  router.query = { ...next };
  forceRerender?.();
}

const currentQuery = () => router.query as Record<string, string>;

beforeEach(() => {
  mocks.items = [makeCard('a', 'Alpha App'), makeCard('b', 'Bravo App', 'offsite')];
  mocks.lastArgs = null;
  router.query = {};
  forceRerender = null;
  replaceCalls = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openFilters() {
  await userEvent.click(page.getByTestId('apps-store-filters-dropdown'));
  await expect.element(page.getByTestId('apps-store-filters-panel')).toBeInTheDocument();
}

describe('the harness itself round-trips (guard on the guard)', () => {
  test('a filter click actually lands in router.query', async () => {
    // If this fails, every assertion below is meaningless — the inert scaffold
    // router would make the racing test pass for the wrong reason.
    renderWithProviders(<StatefulRouterHarness latencyMs={0} />);
    await openFilters();
    await userEvent.click(page.getByRole('button', { name: 'Standalone' }));
    await vi.waitFor(() => expect(currentQuery()).toMatchObject({ kind: 'offsite' }));
    // …and the component re-renders FROM the URL.
    await vi.waitFor(() => expect(mocks.lastArgs).toMatchObject({ kind: 'offsite' }));
  });
});

describe('(a) the search box tracks an EXTERNAL query change', () => {
  test('🔴 browser Back clears the box — it does not keep filtering by a dead term', async () => {
    renderWithProviders(<StatefulRouterHarness latencyMs={0} />);
    const search = page.getByLabelText('Search');
    await expect.element(search).toBeInTheDocument();

    await search.fill('Alpha');
    await vi.waitFor(() => expect(currentQuery()).toMatchObject({ query: 'Alpha' }));
    // The grid is filtered to Alpha.
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    expect(page.getByText('Bravo App').elements()).toHaveLength(0);

    // Back to the unfiltered URL.
    navigateTo({});

    // The box must follow the URL. Before the fix it kept "Alpha", and because
    // `filteredItems` reads the BOX (not the URL) the grid stayed filtered while
    // the address bar said otherwise.
    await vi.waitFor(() => expect((search.element() as HTMLInputElement).value).toBe(''));
    await expect.element(page.getByText('Bravo App')).toBeInTheDocument();
  });

  test('a Back that lands on a DIFFERENT term adopts that term', async () => {
    router.query = { query: 'Alpha' };
    renderWithProviders(<StatefulRouterHarness latencyMs={0} />);
    const search = page.getByLabelText('Search');
    await expect.element(search).toHaveValue('Alpha');

    navigateTo({ query: 'Bravo' });
    await vi.waitFor(() => expect((search.element() as HTMLInputElement).value).toBe('Bravo'));
    await expect.element(page.getByText('Bravo App')).toBeInTheDocument();
  });

  test('typing is NOT clobbered by the re-sync (no fight with our own echo)', async () => {
    // The re-sync must not fire on the URL update that our OWN debounced write
    // causes, or the box would be reset mid-typing.
    renderWithProviders(<StatefulRouterHarness latencyMs={0} />);
    const search = page.getByLabelText('Search');
    await expect.element(search).toBeInTheDocument();
    await search.fill('Alpha');
    await vi.waitFor(() => expect(currentQuery()).toMatchObject({ query: 'Alpha' }));
    // Still exactly what was typed, after the round-trip settled.
    await expect.element(search).toHaveValue('Alpha');
  });
});

describe('(b) two fast filter clicks must not drop one', () => {
  test('🔴 kind then category, both inside the in-flight window, both survive', async () => {
    renderWithProviders(<StatefulRouterHarness latencyMs={ROUTER_LATENCY_MS} />);
    await openFilters();

    await userEvent.click(page.getByRole('button', { name: 'Embedded' }));
    await userEvent.click(page.getByRole('button', { name: 'Generation' }));

    await vi.waitFor(() => {
      expect(currentQuery()).toMatchObject({ kind: 'onsite', category: 'generation' });
    });
    // …and the panel, which now renders FROM the url, shows both as pressed
    // rather than visibly reverting the first one.
    await expect
      .element(page.getByRole('button', { name: 'Embedded' }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect
      .element(page.getByRole('button', { name: 'Generation' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('a sort change racing a kind change keeps both', async () => {
    renderWithProviders(<StatefulRouterHarness latencyMs={ROUTER_LATENCY_MS} />);
    await openFilters();
    await userEvent.click(page.getByRole('button', { name: 'Standalone' }));
    // Close the panel and change sort immediately.
    await userEvent.click(page.getByLabelText('Sort').first());
    await userEvent.click(page.getByRole('option', { name: 'Newest' }));
    await vi.waitFor(() => {
      expect(currentQuery()).toMatchObject({ kind: 'offsite', sort: 'newest' });
    });
  });

  test('clearing a filter still CLEARS it (the merge must not resurrect defaults)', async () => {
    // The mirror risk of fixing (b) by merging: a write that sets a field back to
    // its default must still drop the param, not re-add it from the merged state.
    router.query = { kind: 'offsite', category: 'generation' };
    renderWithProviders(<StatefulRouterHarness latencyMs={0} />);
    await openFilters();
    await userEvent.click(page.getByTestId('apps-store-filters-clear'));
    await vi.waitFor(() => {
      expect(currentQuery()).not.toHaveProperty('kind');
      expect(currentQuery()).not.toHaveProperty('category');
    });
  });
});

/**
 * (c) THE PING-PONG. Reproduced on production 2026-08-13: typing into the store
 * search box started an UNBOUNDED `history.replaceState` oscillation —
 * `/apps?query=X` → `/apps` → `/apps?query=X` → … at ~1.8 writes/sec, never
 * settling, ending with the term stripped from the URL.
 *
 * 🔴 WHY THE SUITE ABOVE COULD NOT SEE IT. Every assertion in (a) and (b) is a
 * RETRYING matcher, and an oscillation swings through the expected value on
 * every cycle — so "typing is NOT clobbered by the re-sync" was GREEN on the
 * broken code. The defect is not a wrong value, it is a value that will not stop
 * changing, and only a COUNT that must stop growing can express that.
 *
 * The mechanism is written up at the adopt effect in
 * `AppListingsMarketplaceBody.tsx`: the debounced echo and the URL→box adopt
 * both run in the SAME commit, and the adopt's `isWritePending` guard used to be
 * a render-time boolean, sampled before the echo had incremented it.
 */
describe('(c) typing must SETTLE — no unbounded route-write ping-pong', () => {
  test('🔴 one search term → route writes STOP, and `?query=` sticks', async () => {
    renderWithProviders(<StatefulRouterHarness latencyMs={0} />);
    const search = page.getByLabelText('Search');
    await expect.element(search).toBeInTheDocument();

    await search.fill('Alpha');
    await vi.waitFor(() => expect(currentQuery()).toMatchObject({ query: 'Alpha' }));

    // 1.8s ≈ 3 full periods of the production loop (2 × the 300ms debounce), so
    // on the unfixed code this window CANNOT be quiet. Sampling — rather than
    // one reading at the end — is deliberate: a single final read of the URL is
    // a coin flip against an oscillation, and would make this test flaky-green
    // instead of reliably red.
    const settledAt = replaceCalls;
    const writes: number[] = [];
    const urlQueries: unknown[] = [];
    const boxValues: string[] = [];
    for (let i = 0; i < 18; i++) {
      await sleep(100);
      writes.push(replaceCalls);
      urlQueries.push(currentQuery().query);
      boxValues.push((search.element() as HTMLInputElement).value);
    }

    // BOUNDED: not one further route write after the term landed.
    expect(writes).toEqual(writes.map(() => settledAt));
    // STICKS: `?query=Alpha` is present at EVERY instant — it never reverts to a
    // bare `/apps`, which is the end state the production repro landed on.
    expect(urlQueries).toEqual(urlQueries.map(() => 'Alpha'));
    // …and the box is not wiped out from under the viewer on the way there.
    expect(boxValues).toEqual(boxValues.map(() => 'Alpha'));
  });

  test('🔴 …and with a SLOW router too (the in-flight window is real)', async () => {
    // Same claim at the other end of the dimension the hook's counter exists
    // for: a `router.replace` that takes 500ms to land. One measurement at
    // latency 0 would say nothing about the window where the counter is doing
    // the work.
    renderWithProviders(<StatefulRouterHarness latencyMs={ROUTER_LATENCY_MS} />);
    const search = page.getByLabelText('Search');
    await expect.element(search).toBeInTheDocument();

    await search.fill('Alpha');
    await vi.waitFor(() => expect(currentQuery()).toMatchObject({ query: 'Alpha' }));

    const settledAt = replaceCalls;
    const writes: number[] = [];
    const urlQueries: unknown[] = [];
    for (let i = 0; i < 18; i++) {
      await sleep(100);
      writes.push(replaceCalls);
      urlQueries.push(currentQuery().query);
    }
    expect(writes).toEqual(writes.map(() => settledAt));
    expect(urlQueries).toEqual(urlQueries.map(() => 'Alpha'));
    await expect.element(search).toHaveValue('Alpha');
  });
});
