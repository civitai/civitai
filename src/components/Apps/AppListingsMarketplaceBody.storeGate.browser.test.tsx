import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * 🔒 `AppListingsMarketplaceBody` — the STORE-VISIBILITY gate on the grid query.
 *
 * WHY A DEDICATED FILE: the shared-predicate extraction converted six sites, but
 * an adversarial audit reverted four of them to `!!features.appBlocks` and the
 * entire existing suite stayed green — the mutant survived. The call-site ledger
 * (`__tests__/appsStoreAccessCallSites.test.ts`) now pins all six STRUCTURALLY,
 * but a structural check cannot see a call passed the wrong argument. This file
 * is the BEHAVIOURAL half for the busiest of the four: it drives the flag matrix
 * and observes what the component actually does with `enabled`.
 *
 * Unlike the sibling `AppListingsMarketplaceBody.browser.test.tsx` (which pins
 * `useFeatureFlags` to a constant and ignores query options), this file makes the
 * flags a VARIABLE and captures the `enabled` option — the two things the gate is
 * made of.
 *
 * 🔴 The gate here mirrors the SERVER read gate (`enforceAppListingsReadFlag` →
 * `isAppListingsEnabled`, which ORs both flags), which is why this query DOES
 * widen with the store — in deliberate contrast to `blocks.getNavSummary`, whose
 * `enabled` stays on `appBlocks` alone because ITS proc gates on
 * `enforceAppBlocksFlag`. See `AppsSubNav.storeGate.browser.test.tsx`.
 */

function makeCard(id: string, name: string): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
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
    openCount: 0,
    kindData: {
      kind: 'onsite',
      appBlockId: `blk-${id}`,
      hasPage: false,
      liveUrl: `https://slug-${id}.civit.ai`,
    },
  };
}

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  items: [] as ListingCard[],
  /** Every `enabled` value the grid query was called with, in order. */
  enabledSeen: [] as unknown[],
}));

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
  useFeatureFlags: () => mocks.flags,
  useOptionalFeatureFlags: () => mocks.flags,
}));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-
// mock): a hand-written replacement silently breaks every importer the day
// '~/utils/trpc' grows an export this factory omits — the whole FILE then fails to
// load with 0 tests collected and no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: {
        useInfiniteQuery: (_input: Record<string, unknown>, opts?: { enabled?: boolean }) => {
          mocks.enabledSeen.push(opts?.enabled);
          // Honour `enabled` like the real hook: a disabled query resolves no data,
          // so a gated-out viewer gets an empty grid rather than listings.
          return {
            data: opts?.enabled
              ? { pages: [{ items: mocks.items, nextCursor: undefined }] }
              : undefined,
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

// Not a real hook: the scaffold mocks `next/router` with `useRouter: () => router`,
// a plain function returning a singleton, so module-scope is fine (and is the
// established idiom — a per-file `vi.mock` silently loses to the setup-file mock).
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

/**
 * 🔴 RENDER BARRIER — required before any "did not render" assertion.
 *
 * React 18 commits on a LATER task, so a synchronous absence check straight after
 * `renderWithProviders` reads an empty container and passes regardless of what the
 * component did. Measured on the sibling sub-nav suite: with the barrier removed,
 * the absence tests pass in ~4ms even with the gate neutered.
 */
const RENDER_BARRIER = 'render-barrier';
const RenderBarrier = () => <div data-testid={RENDER_BARRIER} />;

async function renderBody() {
  renderWithProviders(
    <>
      <RenderBarrier />
      <AppListingsMarketplaceBody />
    </>
  );
  await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
}

beforeEach(() => {
  mocks.flags = {};
  mocks.items = [makeCard('a', 'Alpha App'), makeCard('b', 'Bravo App')];
  mocks.enabledSeen = [];
  // A FRESH object each test: `useZodRouteParams` memoises on the `query` reference.
  router.query = {};
});

describe('AppListingsMarketplaceBody — the grid query uses the shared store predicate', () => {
  test('🔴 appListings ONLY (appBlocks OFF) → the grid query is ENABLED and listings render', async () => {
    // The exact mutant that survived: reverting this site to `!!features.appBlocks`
    // disables the query for this cohort and fails HERE, on these assertions.
    mocks.flags = { appListings: true, appBlocks: false };
    await renderBody();

    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    expect(mocks.enabledSeen.some((e) => e === true)).toBe(true);
    expect(mocks.enabledSeen.every((e) => e !== false)).toBe(true);
  });

  test('appBlocks ONLY (appListings OFF) → enabled (the OR-fallback cohort)', async () => {
    mocks.flags = { appListings: false, appBlocks: true };
    await renderBody();

    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    expect(mocks.enabledSeen.some((e) => e === true)).toBe(true);
  });

  test('BOTH flags true → enabled (today’s live cohort, unchanged)', async () => {
    mocks.flags = { appListings: true, appBlocks: true };
    await renderBody();

    await expect.element(page.getByText('Bravo App')).toBeInTheDocument();
    expect(mocks.enabledSeen.some((e) => e === true)).toBe(true);
  });

  test('NEITHER flag → the query is DISABLED and no listing renders', async () => {
    mocks.flags = { appListings: false, appBlocks: false };
    await renderBody(); // barrier awaited inside — absence below is a real observation

    expect(mocks.enabledSeen.length).toBeGreaterThan(0); // the hook did run
    expect(mocks.enabledSeen.every((e) => e === false)).toBe(true);
    expect(page.getByText('Alpha App').elements()).toHaveLength(0);
    expect(page.getByText('Bravo App').elements()).toHaveLength(0);
  });

  test('flags ABSENT entirely (Flipt down) → disabled (fails closed)', async () => {
    mocks.flags = {};
    await renderBody();

    expect(mocks.enabledSeen.every((e) => e === false)).toBe(true);
    expect(page.getByText('Alpha App').elements()).toHaveLength(0);
  });

  // 🔴 POSITIVE CONTROL for the two absence tests above: if `getByText` were
  // wired to nothing it would report zero for every input, and both would be
  // vacuously green.
  test('POSITIVE CONTROL: the same reader DOES find the card when the gate opens', async () => {
    mocks.flags = { appListings: true, appBlocks: false };
    await renderBody();
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    expect(page.getByText('Alpha App').elements().length).toBeGreaterThan(0);
  });
});
