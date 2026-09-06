/**
 * `/apps` store — THE GRID DOES NOT EMPTY ACROSS A FILTER CHANGE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING GUARDED
 * ─────────────────────────────────────────────────────────────────────────────
 * `appListings.listAvailable` is keyed on `{kind, category, sort, limit}`, so every
 * sort/filter change is a NEW query key. Without `placeholderData: keepPreviousData`
 * react-query hands back `data: undefined` for the duration of the round trip:
 * `items` empties, the grid collapses to zero rows, the page jumps, and everything
 * comes back a moment later. That is a full-height layout shift on a control the
 * viewer touched expecting a re-ORDER.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THIS TEST DELEGATES TO A REAL `useInfiniteQuery`
 * ─────────────────────────────────────────────────────────────────────────────
 * Every sibling spec mocks `trpc.appListings.listAvailable.useInfiniteQuery` with a
 * function that returns a literal object. Against such a mock this behaviour is
 * UNTESTABLE: the mock decides what `data` is, so the component's option is inert
 * and the test would pass with `placeholderData` deleted — the classic guard that
 * reads as coverage while providing none.
 *
 * So the mock here is a THIN ADAPTER: it forwards the component's own `input` and
 * its own `options` object into react-query's real `useInfiniteQuery`. The query key
 * is built from that input, so a sort change really does change the key, and
 * `placeholderData` really is the thing deciding what `data` holds while the new key
 * loads. Delete the option from the component and this file goes red — verified, see
 * the mutation table in the PR body.
 *
 * ⚠️ WHAT IT DOES NOT COVER, STATED SO IT IS NOT COUNTED TWICE. The URL plumbing.
 * `useAppsStoreQueryParams` is mocked to a controllable store, because driving the
 * sort through the real hook needs a router that actually re-renders on `replace` —
 * a different surface, already covered by
 * `AppListingsMarketplaceBody.urlState.browser.test.tsx`. What this file owns is
 * what the QUERY does once the filters have moved.
 *
 * ⚠️ AND: the `component` tier never gates anything (`preview / component-tests` is
 * report-only), so this catches a regression when someone runs it, not at merge. The
 * canonical tier note is in `appListingCardGeometry.ts`.
 */
import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

function makeCard(id: string, name: string): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name,
    tagline: null,
    category: null,
    contentRating: null,
    isBeta: false,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    openCount: 0,
    kindData: {
      kind: 'onsite',
      appBlockId: `blk-${id}`,
      hasPage: false,
      liveUrl: `https://slug-${id}.civit.ai`,
    },
  };
}

/**
 * The controllable half of the harness.
 *
 * `pending` is a queue of the queries the component has STARTED and not yet been
 * given an answer to. Holding them open is what makes "while the new page loads" an
 * observable state rather than a race — nothing here waits on a timer.
 */
const mocks = vi.hoisted(() => ({
  sort: 'top-rated' as string,
  listeners: new Set<() => void>(),
  pending: [] as { sort: string; resolve: (items: unknown[]) => void }[],
  /** The options object the COMPONENT handed the query, captured by the adapter. */
  lastOptions: null as Record<string, unknown> | null,
}));

function setSort(next: string) {
  mocks.sort = next;
  for (const l of mocks.listeners) l();
}

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));
// Both flag hooks — a factory that names only one makes the whole FILE fail to
// import and reports `Tests no tests` rather than a failure. See the long note in
// `AppListingsMarketplaceBody.browser.test.tsx`.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
  useFeatureFlagsReady: () => true,
}));

/**
 * The filters, as an external store the test can move.
 *
 * `useSyncExternalStore` rather than component state so `setSort` can be called from
 * the test body and still produce a real React re-render of the subject.
 */
vi.mock('~/components/Apps/useAppsStoreQueryParams', async () => {
  const React = await import('react');
  const subscribe = (cb: () => void) => {
    mocks.listeners.add(cb);
    return () => mocks.listeners.delete(cb);
  };
  const snapshot = () => mocks.sort;
  return {
    useAppsStoreQueryParams: () => {
      const sort = React.useSyncExternalStore(subscribe, snapshot, snapshot);
      return {
        filters: { kind: 'all' as const, category: null, sort, query: '' },
        setFilters: vi.fn(),
        hasPendingWrite: () => false,
      };
    },
  };
});

/**
 * 🔴 THE ADAPTER. It passes the component's OWN options object straight through, so
 * `placeholderData`, `getNextPageParam` and `enabled` are the component's decisions,
 * not this file's. `queryKey` is built from the component's own input, so the key
 * changes exactly when the component's input does.
 */
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useInfiniteQuery } = await import('@tanstack/react-query');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: {
      appListings: {
        listAvailable: {
          useInfiniteQuery: (input: Record<string, unknown>, options: Record<string, unknown>) => {
            mocks.lastOptions = options;
            // 🔴 CAST, BECAUSE THE OPTIONS ARRIVE AT RUNTIME. `getNextPageParam` is
            // required by `useInfiniteQuery`'s type and is supplied by the COMPONENT,
            // which is the whole point of this adapter — TypeScript cannot see that it
            // is present in the spread, so the object is asserted rather than the
            // option duplicated here (duplicating it is what would make the test
            // measure the harness).
            return useInfiniteQuery({
              queryKey: ['appListings.listAvailable', input],
              queryFn: () =>
                new Promise((resolve) => {
                  mocks.pending.push({
                    sort: String(input.sort),
                    resolve: (items) => resolve({ items, nextCursor: undefined }),
                  });
                }),
              initialPageParam: undefined,
              ...options,
            } as unknown as Parameters<typeof useInfiniteQuery>[0]);
          },
        },
      },
      blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } },
    },
  };
});

const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');

const cardCells = () => document.querySelectorAll('[data-testid="apps-listing-grid-col"]').length;
const skeletonCells = () =>
  document.querySelectorAll('[data-testid="apps-listing-skeleton-col"]').length;
const pendingGrids = () => document.querySelectorAll('[data-pending]').length;

/** Answer the oldest outstanding query. Throws rather than no-op if there is none. */
function resolveNext(items: ListingCard[]) {
  const next = mocks.pending.shift();
  if (!next) throw new Error('no query is outstanding — the component never started one');
  next.resolve(items);
  return next;
}

describe('🔴 a sort change re-orders the store without emptying it', () => {
  test('the previous page stays on screen, dimmed, while the new one loads', async () => {
    mocks.sort = 'top-rated';
    mocks.pending = [];
    const FIRST = [makeCard('a1', 'Prompt Vault'), makeCard('a2', 'Kerf'), makeCard('a3', 'Nudge')];
    const SECOND = [makeCard('b1', 'Stipple'), makeCard('b2', 'Tessellate')];

    renderWithProviders(<AppListingsMarketplaceBody />);

    // ── FIRST LOAD ────────────────────────────────────────────────────────────
    // Nothing cached, so this is the genuine `isLoading` branch: skeletons, and NO
    // card cells. (Asserted positively — `not.toBeInTheDocument()` is inert in this
    // repo, issue #4197 — so every absence below is a COUNT of zero.)
    await expect.poll(() => skeletonCells()).toBeGreaterThan(0);
    expect(cardCells()).toBe(0);

    await expect.poll(() => mocks.pending.length).toBe(1);
    resolveNext(FIRST);
    await expect.poll(() => cardCells()).toBe(FIRST.length);
    expect(skeletonCells()).toBe(0);
    expect(pendingGrids()).toBe(0);

    // ── THE FILTER CHANGE ─────────────────────────────────────────────────────
    setSort('newest');

    // 🔴 POSITIVE CONTROL, FIRST. "The grid did not empty" is also what you observe
    // when NOTHING HAPPENED — a mocked filter store that failed to re-render, a
    // query key that did not actually change. So prove a second query really is in
    // flight, for the new sort, before reading anything into the grid's contents.
    await expect.poll(() => mocks.pending.length).toBe(1);
    expect(mocks.pending[0].sort).toBe('newest');

    // ── THE ASSERTION ─────────────────────────────────────────────────────────
    expect(
      cardCells(),
      'the store emptied while the re-sorted page loaded — every card unmounted and the ' +
        'grid collapsed to zero rows. That is the layout shift `placeholderData: ' +
        'keepPreviousData` exists to remove; check it is still passed to the query.'
    ).toBe(FIRST.length);
    // …and it is not the SKELETON standing in for them either: that would be the
    // same collapse wearing a different costume, since two rows of skeletons is not
    // three cards.
    expect(skeletonCells()).toBe(0);
    // The stale marker is up, so the viewer is told the result is being replaced.
    expect(
      pendingGrids(),
      'the grid is showing a stale result set with no pending affordance — a sort ' +
        'change then looks like it did nothing for a whole round trip'
    ).toBe(1);

    // ── AND THE NEW PAGE LANDS ────────────────────────────────────────────────
    resolveNext(SECOND);
    await expect.poll(() => cardCells()).toBe(SECOND.length);
    // The counts differ, which is what makes the assertion above a claim about
    // IDENTITY rather than about a number that happens to be stable.
    expect(SECOND.length).not.toBe(FIRST.length);
    await expect.poll(() => pendingGrids()).toBe(0);
  });

  /**
   * 🔴 THE PATH `keepPreviousData` QUIETLY TOOK A LOADING AFFORDANCE AWAY FROM.
   *
   * When the previous page is EMPTY there is no grid to dim. `isLoading` is false
   * (that is what `keepPreviousData` buys), `filteredItems` is `[]`, so the empty
   * state wins and "No apps match" sits there — undimmed, unannounced, no skeleton —
   * for the whole round trip. Measured at `isPlaceholderData: true` over a previous
   * page of `items: []`: `{pendingEls: 0, ariaBusyEls: 0, skeletonCells: 0,
   * showsNoAppsYet: true}`.
   *
   * 🔴 AND IT IS A REGRESSION AGAINST PRE-PR BEHAVIOUR, NOT JUST A GAP: before this
   * change a new query key gave `data: undefined` → `isLoading: true` → the spinner.
   * So without the fix this PR is a net LOSS on that path, which is the shape a
   * feature-flagged improvement is most likely to ship unnoticed.
   *
   * Found by an adversarial audit. The scenario is ordinary: filter to a category
   * with nothing in it, then change the sort.
   */
  test('🔴 a stale EMPTY previous page still shows a loading affordance', async () => {
    mocks.sort = 'top-rated';
    mocks.pending = [];

    renderWithProviders(<AppListingsMarketplaceBody />);

    // First load resolves to NOTHING — the viewer has filtered into an empty corner.
    await expect.poll(() => mocks.pending.length).toBe(1);
    resolveNext([]);
    await expect.poll(() => document.body.textContent).toContain('No apps');
    expect(cardCells()).toBe(0);
    expect(skeletonCells()).toBe(0);

    // They change the sort. The placeholder is that same empty page.
    setSort('newest');

    // POSITIVE CONTROL FIRST — a second query really is in flight for the new sort.
    // Without this, "a skeleton appeared" could just mean nothing happened at all.
    await expect.poll(() => mocks.pending.length).toBe(1);
    expect(mocks.pending[0].sort).toBe('newest');

    await expect
      .poll(() => skeletonCells(), {
        message:
          'the store showed NO loading affordance while re-sorting an empty result ' +
          'set: no skeleton, and no grid to dim either. Before keepPreviousData this ' +
          'path rendered a spinner, so this is a regression, not a gap. Check that ' +
          '`showingStaleEmpty` still short-circuits ahead of `showingEmpty`.',
      })
      .toBeGreaterThan(0);

    // …and the empty state is NOT also on screen — the two must not stack.
    // 🔴 'No apps', not 'No apps match'. With no filters active the empty state reads
    // "No apps YET", so asserting the absence of the *filtered* wording would pass
    // whether or not the empty state rendered — a check that cannot fail.
    expect(document.body.textContent).not.toContain('No apps');

    // The new page lands and the store settles back to its ordinary empty state.
    resolveNext([]);
    await expect.poll(() => skeletonCells()).toBe(0);
    await expect.poll(() => document.body.textContent).toContain('No apps');
  });

  /**
   * 🔴 GUARD-THE-GUARD, BY IDENTITY. The test above would measure the HARNESS rather
   * than the component if this file supplied `placeholderData` itself — it would then
   * stay green with the option deleted from the source, which is the exact shape of a
   * guard that reads as coverage while providing none.
   *
   * So the adapter captures the options object the COMPONENT passed, and this asserts
   * that its `placeholderData` is react-query's own `keepPreviousData` FUNCTION — the
   * same module object, not a string, not a value spelled twice.
   */
  test('the component — not this harness — supplies placeholderData: keepPreviousData', async () => {
    const { keepPreviousData } = await import('@tanstack/react-query');
    mocks.sort = 'top-rated';
    mocks.pending = [];
    // Typed on the way in: a bare `= null` narrows the property to `null` for the
    // rest of this function, which makes every read below `never`.
    mocks.lastOptions = null as Record<string, unknown> | null;
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.poll(() => mocks.lastOptions !== null).toBe(true);
    // Read through a local: assigning `null` above narrows the property's type to
    // `null` for the rest of this function, which would make the reads below `never`.
    const captured: Record<string, unknown> | null = mocks.lastOptions;
    expect(captured, 'the adapter never saw an options object').not.toBeNull();
    expect(
      captured?.placeholderData,
      'the store query no longer asks react-query to keep the previous page. The grid ' +
        'will empty on every sort/filter change.'
    ).toBe(keepPreviousData);
    // Positive control on the capture itself: an adapter wired to nothing would also
    // report an options object with no `placeholderData`, so prove it carried the
    // component's OTHER options too.
    expect(typeof captured?.getNextPageParam).toBe('function');
  });
});
