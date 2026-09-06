import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * Regression: `/apps` STORE HYDRATION SAFETY — the sibling of
 * `AppsSubNav.hydration.browser.test.tsx`, for the change that put the store's
 * filters in the URL.
 *
 * THE INCIDENT THIS GUARDS (see the long comment in `AppsSubNav.tsx`): a value
 * that differed between the SERVER render and the FIRST CLIENT render bailed
 * React hydration (#418/#425) at the `/apps` page ROOT, leaving EVERY `/apps`
 * page un-hydrated and inert — dead buttons, queries that never fired. It was
 * latent, and only appeared for accounts whose client-only state diverged.
 * Reading URL state during the first client render is exactly that class.
 *
 * THE INVARIANT, stated precisely: the store's filter state must be a PURE
 * FUNCTION OF `router.query`, with no client-only input (`window.location`,
 * `localStorage`, a media query, a clock). `router.query` is populated
 * identically on the server and the first client paint for this
 * `getServerSideProps` page, so a pure derivation is identical on both by
 * construction.
 *
 * 🔴 WHY THE FIX IS *NOT* "GATE THE FILTERS ON `useIsClient()`". That is the
 * obvious mitigation and it is the wrong one HERE: it would make every shared
 * `/apps?kind=…` link paint the DEFAULT grid, fire a tRPC query for it, then
 * swap — a visible flash plus a wasted round-trip on the exact path the feature
 * exists to serve. `useIsClient()` is the right tool when the value genuinely
 * cannot be known on the server (the sub-nav's tRPC-driven tab set; the count
 * `Indicator` inside `AdaptiveFiltersDropdown`, which is already gated that way).
 * It is the wrong tool when the value IS knowable on the server, as this one is.
 *
 * So these tests assert the invariant directly rather than asserting a
 * mechanism: `mocks.isClient = false` renders the pre-mount tree (server + first
 * client paint) and asserts it ALREADY reflects the URL. Gating the filters on
 * `useIsClient()` fails test 1 and 2; reading `window.location`/`localStorage`
 * during render fails test 4.
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
  // Drives `useIsClient()`. FALSE models the SERVER render *and* the first client
  // paint (both pre-mount); TRUE models a post-mount render.
  isClient: false,
  lastArgs: null as null | Record<string, unknown>,
  items: [] as ListingCard[],
}));

vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => mocks.isClient }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
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
const { clearRecentlyOpenedApps } = await import('./recentlyOpenedAppsStore');

/**
 * ⚠️ SCOPE LIMIT, stated rather than papered over. `mocks.isClient = false`
 * models the pre-mount render for anything gated on `useIsClient()`, but it
 * CANNOT suppress React effects — browser mode always mounts, so a
 * `useEffect`-based mitigation (the recents rail's "seed empty, load after
 * mount") has already run by the time an assertion can look. An attempt to
 * assert the rail's absence pre-mount here failed for exactly that reason and
 * was removed rather than weakened into a guard that proves nothing. The rail's
 * ordering + hide-when-empty behaviour is covered in
 * `AppListingsMarketplaceBody.browser.test.tsx` and `RecentlyOpenedApps.browser.test.tsx`.
 */

/** The scaffold's shared router singleton — a per-file mock loses to the setup file. */
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

const SEEDED = { kind: 'offsite', category: 'generation', sort: 'newest', query: 'matrix' };

beforeEach(() => {
  mocks.isClient = false;
  mocks.lastArgs = null;
  mocks.items = [makeCard('a', 'Alpha App'), makeCard('b', 'Bravo App', 'offsite')];
  router.query = {};
  vi.mocked(router.replace).mockClear();
  clearRecentlyOpenedApps();
});

/**
 * A structural signature of the control row: every control's tag, accessible
 * name, value and pressed state, in document order.
 *
 * Mantine mints a random `id`/`for`/`aria-controls` per instance and emits a
 * per-instance `<style>` class, so raw `innerHTML` differs between two renders
 * of the SAME tree and is useless as a comparison. This normalises to the things
 * a hydration mismatch would actually change.
 */
function controlRowSignature(): string[] {
  const row = document.querySelector('[data-testid="apps-store-control-row"]');
  if (!row) return ['<no control row>'];
  return Array.from(row.querySelectorAll('input,button,[role="group"]')).map((el) =>
    [
      el.tagName,
      el.getAttribute('role') ?? '',
      el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
      (el as HTMLInputElement).value ?? '',
      el.getAttribute('aria-pressed') ?? '',
      el.getAttribute('placeholder') ?? '',
    ].join('|')
  );
}

describe('/apps store — the first client paint already reflects the URL', () => {
  test('🔴 pre-mount, a param-seeded mount drives the LISTING QUERY (no default-then-swap)', async () => {
    router.query = { ...SEEDED };
    mocks.isClient = false; // server + first client paint
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();

    // If the filters were deferred behind `useIsClient()`, this would be the
    // DEFAULT `{kind:'all', category:undefined, sort:'top-rated'}` on the first
    // render and only become the seeded value after mount — a visible flash and a
    // wasted round-trip on every shared link.
    expect(mocks.lastArgs).toMatchObject({
      kind: 'offsite',
      category: 'generation',
      sort: 'newest',
    });
  });

  test('🔴 pre-mount, the CONTROLS themselves show the seeded values', async () => {
    router.query = { ...SEEDED };
    mocks.isClient = false;
    renderWithProviders(<AppListingsMarketplaceBody />);

    // The sort control renders the seeded sort, not the default "Top rated".
    await expect.element(page.getByLabelText('Sort').first()).toHaveValue('Newest');
    // The search box is seeded from `?query=` on its very first render.
    await expect.element(page.getByLabelText('Search')).toHaveValue('matrix');
    // …and so is the collapsed panel's kind toggle. (By testid, not by accessible
    // name: "Filters" is a SUBSTRING of the empty state's "Clear filters" button,
    // so a name query is a strict-mode violation whenever both are on screen.)
    await userEvent.click(page.getByTestId('apps-store-filters-dropdown'));
    await expect
      .element(page.getByRole('button', { name: 'Standalone' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('🔴 the control row is IDENTICAL pre-mount and post-mount (the hydration invariant)', async () => {
    router.query = { ...SEEDED };

    // ONE mount, re-rendered with the flag flipped — which is precisely what
    // happens at hydration: React renders the same tree again, `useIsClient()`
    // has become true, and any divergence between the two is the mismatch.
    // (Unmount-and-remount via `cleanup()` was tried and tears down the harness's
    // container, so every later render lands in an empty body.)
    mocks.isClient = false;
    const { rerender } = await renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    const before = controlRowSignature();

    mocks.isClient = true;
    await rerender(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    const after = controlRowSignature();

    // Guard the guard: a signature of [] (or the sentinel) would make this pass
    // vacuously — exactly how an fs/DOM-scanning assertion lies.
    expect(before).not.toEqual(['<no control row>']);
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(after).toEqual(before);
  });

  test('the count Indicator NUMBER is the ONE client-gated affordance (the existing, correct use)', async () => {
    router.query = { kind: 'offsite', category: 'generation' };
    const badge = () => document.querySelector('.mantine-Indicator-indicator')?.textContent ?? null;

    mocks.isClient = false;
    const { rerender } = await renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    // Server + first client paint: the dot renders (its `disabled` prop is driven
    // by the count, which IS server-knowable) but carries NO NUMBER —
    // `AdaptiveFiltersDropdown` gates only the `label` on `useIsClient()`. That
    // split is the correct call for a SHARED component whose other consumers are
    // not all SSR-stable, and it is consistent across the server render and the
    // first client paint, which is all hydration requires.
    expect(badge()).toBe('');

    mocks.isClient = true;
    await rerender(<AppListingsMarketplaceBody />);
    await vi.waitFor(() => expect(badge()).toBe('2'));
  });
});

describe('/apps store — no client-only source leaks into the first render', () => {
  test('an INVALID seeded param degrades to the default rather than bailing the render', async () => {
    // A crawler, a stale bookmark or a hand-typed URL must not be able to produce
    // a divergent (or throwing) first render.
    router.query = { kind: 'sideways', category: 'hats', sort: 'chaos' };
    mocks.isClient = false;
    renderWithProviders(<AppListingsMarketplaceBody />);
    await expect.element(page.getByLabelText('Sort').first()).toHaveValue('Top rated');
    expect(mocks.lastArgs).toMatchObject({ kind: 'all', sort: 'top-rated' });
    expect(mocks.lastArgs?.category).toBeUndefined();
    // …and the grid still renders — never an empty result set.
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
  });
});
