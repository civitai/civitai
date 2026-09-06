import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import {
  RECENTLY_OPENED_APPS_KEY,
  RECENTS_ENVELOPE_VERSION,
} from '~/components/Apps/recentlyOpenedAppsStore';

/**
 * LEGACY-RECENTS RECONCILIATION — the `/apps` rail's stale-icon defect.
 *
 * 🔴 WHY THIS FILE EXISTS AT ALL, AND WHY IT SEEDS RAW JSON.
 *
 * The rail's icon is DERIVED from where the tile navigates
 * (`getRecentRailAction` → `getRecentRailTarget`), and the target for an on-site
 * entry needs `hasPage`. `resolveRecentApp` reads `entry.hasPage === true`, so an
 * entry that never RECORDED the field resolves to `hasPage: false` and routes to
 * `/apps/store-preview/<slug>` under an EYE — "read about it" — for an app the
 * viewer has already been running. That is a stale-data artifact, not a signal.
 *
 * The entries that hit it are the ones `MarketplaceBody.recordRecent` wrote:
 * `{id, blockId, name, iconUrl}` — no `kind`, no `hasPage`, and NO `slug`. A real
 * viewer's `localStorage.recentlyOpenedApps` was read while diagnosing this: 7 of
 * its 8 entries were exactly that shape. So the fixture below is that shape,
 * seeded as RAW JSON through `localStorage.setItem` rather than built by calling
 * `recordRecentlyOpenedApp` with a fully-populated object.
 *
 * That choice is the whole point of the file. A fixture assembled from the
 * CURRENT `RecentApp` shape encodes the same assumption the bug is made of — that
 * these fields are present — so it would exercise a path the defect never takes
 * and pass while proving nothing. Seeding the bytes that are actually on disk is
 * the only version of this test that can fail for the real reason.
 *
 * Its OWN FILE (not a case appended to `AppListingsMarketplaceBody.browser.test.tsx`)
 * because it needs `appBlocksPages: true` — the run route's flag — where that file
 * pins the flag dark for every one of its tests. Same reason the mobile-drawer and
 * pre-hydration paths get their own files.
 */

/**
 * A card in the exact projection the store read returns. `hasPage` and the
 * on-site `appBlockId` are the two fields reconciliation actually consumes.
 */
function makeOnsiteCard(args: {
  id: string;
  slug: string;
  name: string;
  hasPage: boolean;
  appBlockId?: string | null;
}): ListingCard {
  return {
    id: args.id,
    slug: args.slug,
    kind: 'onsite',
    name: args.name,
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
      appBlockId: args.appBlockId === undefined ? `blk_${args.slug}` : args.appBlockId,
      hasPage: args.hasPage,
      liveUrl: `https://${args.slug}.civit.ai`,
    },
  };
}

const mocks = vi.hoisted(() => ({
  items: [] as ListingCard[],
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-
// module-mock): a hand-written replacement silently breaks every importer the day
// '~/utils/trpc' grows an export this factory omits — the whole FILE then fails to
// load with 0 tests collected and no failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: mocks.items, nextCursor: undefined }] },
          isLoading: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          hasNextPage: false,
        }),
      },
    },
  },
}));

// 🔴 `appBlocksPages: true` — the run route's flag. `getRecentRailTarget` only
// returns `/apps/run/<blockId>` when it is on, so with the flag dark EVERY tile
// resolves to the detail page and this file's central assertion would pass on the
// broken build for the wrong reason.
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
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

// Both throw rather than defaulting when their provider is absent, taking the
// whole body down with an empty <body> — see the sibling file's note.
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));

// Import AFTER mocks (vi.mock is hoisted, static imports are not).
const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');

// Not a real hook: the scaffold mocks `next/router` with `useRouter: () => router`,
// a plain function returning a singleton, so module scope is fine (and a per-file
// `vi.mock('next/router')` silently LOSES to the setup-file mock).
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

/**
 * THE LEGACY PAYLOAD, verbatim in shape: `name` + `blockId` (+ the `id` that is
 * the store's de-dup key). No `kind`, no `hasPage`, no `slug`.
 */
function seedLegacyRecents(entries: { id: string; blockId: string; name: string }[]) {
  seedOwnedRecents(entries);
}

/**
 * Write a raw entry list into the store as the CURRENT (anonymous) viewer's.
 *
 * 🔴 The envelope is the point, not boilerplate. Recents are ACCOUNT-scoped
 * (#4048): a bare `RecentApp[]` carries no owner, and an unowned blob is
 * DROPPED on read rather than attributed to whoever reads it next — so seeding
 * one here would empty the rail and make every reconciliation assertion below
 * pass vacuously. This suite mounts anonymously (`useCurrentUser` → null), so
 * the owner it seeds as is `null`.
 */
function seedOwnedRecents(entries: unknown[], ownerId: number | null = null) {
  window.localStorage.setItem(
    RECENTLY_OPENED_APPS_KEY,
    JSON.stringify({ v: RECENTS_ENVELOPE_VERSION, ownerId, apps: entries })
  );
}

beforeEach(() => {
  mocks.items = [];
  router.query = {};
  window.localStorage.removeItem(RECENTLY_OPENED_APPS_KEY);
});

/** The `tabler-icon-*` modifier on a glyph, e.g. `player-play`. Stable across a
 *  patch bump in a way the raw path `d` is not. */
function glyphOf(el: Element): string {
  const svg = el.querySelector('svg');
  if (!svg) throw new Error('rail action rendered no glyph at all');
  const modifier = Array.from(svg.classList).find(
    (c) => c.startsWith('tabler-icon-') && c !== 'tabler-icon'
  );
  if (!modifier)
    throw new Error(`glyph carried no tabler-icon-* class: ${svg.getAttribute('class')}`);
  return modifier.replace('tabler-icon-', '');
}

describe('the /apps rail reconciles LEGACY recents against the loaded listings', () => {
  /**
   * 🔴 THE REGRESSION TEST. Red on pre-change source: the entry resolves
   * `hasPage: false`, so the tile renders an EYE pointing at
   * `/apps/store-preview/gen-matrix` labelled "View details for Gen Matrix".
   *
   * All THREE are asserted, not just the icon, because they are one decision:
   * `getRecentRailAction` derives the label from the same target that produces
   * the href, and the icon from that action. Asserting the glyph alone would
   * still pass if a future edit hard-coded a play icon onto a tile that navigates
   * to the detail page — the exact "lie in the accessible name" the derivation
   * exists to prevent.
   */
  test('a {name, blockId}-only entry whose app IS on a loaded page → play + /apps/run/ + "Open"', async () => {
    mocks.items = [
      makeOnsiteCard({ id: 'lst_gm', slug: 'gen-matrix', name: 'Gen Matrix', hasPage: true }),
    ];
    seedLegacyRecents([{ id: 'blk_gen-matrix', blockId: 'gen-matrix', name: 'Gen Matrix' }]);

    renderWithProviders(<AppListingsMarketplaceBody />);

    const action = page.getByTestId('apps-recent-rail-action');
    await expect.element(action).toBeInTheDocument();

    // The href — reconciliation's actual effect. Pre-change: /apps/store-preview/gen-matrix.
    await expect.element(action).toHaveAttribute('href', '/apps/run/gen-matrix');
    // The accessible name, by ROLE. `getByRole('link')` also proves the CTA is a
    // real anchor rather than a <button href> (that build shipped once).
    await expect.element(page.getByRole('link', { name: 'Open Gen Matrix' })).toBeInTheDocument();
    // …and the glyph the viewer actually sees. Pre-change: `eye`.
    expect(glyphOf(action.element())).toBe('player-play');
  });

  /**
   * The NON-REGRESSION half, and the reason reconciliation UPGRADES rather than
   * FILTERS. A recents entry for an app that is simply not on a loaded page —
   * page 2, a different `kind`/`category` filter, a listing that no longer exists —
   * must keep working exactly as it does today. Dropping it would silently empty a
   * returning viewer's rail, which is the failure the whole resolve-don't-drop
   * design exists to avoid.
   */
  test('an UNMATCHED legacy entry keeps its current behaviour — never dropped, never upgraded', async () => {
    mocks.items = [
      makeOnsiteCard({ id: 'lst_gm', slug: 'gen-matrix', name: 'Gen Matrix', hasPage: true }),
    ];
    seedLegacyRecents([
      { id: 'blk_prompt-vault', blockId: 'prompt-vault', name: 'Prompt Vault' },
      { id: 'blk_gen-matrix', blockId: 'gen-matrix', name: 'Gen Matrix' },
    ]);

    renderWithProviders(<AppListingsMarketplaceBody />);

    await expect.element(page.getByTestId('apps-recent-rail')).toBeInTheDocument();
    const actions = page.getByTestId('apps-recent-rail-action').elements();
    // BOTH tiles still render — the unmatched one was not filtered out.
    expect(actions).toHaveLength(2);

    // Newest-first order is preserved, so [0] is the unmatched Prompt Vault: it
    // keeps the conservative detail target it has today.
    expect(actions[0].getAttribute('href')).toBe('/apps/store-preview/prompt-vault');
    expect(glyphOf(actions[0])).toBe('eye');
    expect(actions[0].getAttribute('aria-label')).toBe('View details for Prompt Vault');

    // …and the matched one is upgraded alongside it.
    expect(actions[1].getAttribute('href')).toBe('/apps/run/gen-matrix');
    expect(glyphOf(actions[1])).toBe('player-play');
  });

  /**
   * 🔴 RECONCILIATION IS A CORRECTION, NOT A PROMOTION. The card is the server's
   * truth in BOTH directions: an app that has LOST its page must lose the play
   * glyph too, or the rail offers a guaranteed 404 under an "Open" label.
   *
   * This is the mutation-sensitive direction. A reconcile implemented as "fill in
   * missing fields only" (`hasPage: entry.hasPage ?? card.hasPage`) passes the two
   * tests above and fails here.
   */
  test('a persisted hasPage:true is CORRECTED DOWN when the card says the app has no page', async () => {
    mocks.items = [
      makeOnsiteCard({ id: 'lst_pv', slug: 'prompt-vault', name: 'Prompt Vault', hasPage: false }),
    ];
    // A fully-populated, NON-legacy entry that went stale the other way.
    seedOwnedRecents([
      {
        id: 'blk_prompt-vault',
        blockId: 'prompt-vault',
        slug: 'prompt-vault',
        kind: 'onsite',
        hasPage: true,
        name: 'Prompt Vault',
      },
    ]);

    renderWithProviders(<AppListingsMarketplaceBody />);

    const action = page.getByTestId('apps-recent-rail-action');
    await expect.element(action).toBeInTheDocument();
    await expect.element(action).toHaveAttribute('href', '/apps/store-preview/prompt-vault');
    expect(glyphOf(action.element())).toBe('eye');
  });

  /**
   * The store's de-dup key is `id`, and BOTH on-site writers key it on the
   * AppBlock id. Matching by that key (not only by `blockId`) is what lets an
   * entry whose `blockId` was never written still reconcile.
   */
  test('an entry with NO blockId reconciles via its id against the card appBlockId', async () => {
    mocks.items = [
      makeOnsiteCard({
        id: 'lst_gm',
        slug: 'gen-matrix',
        name: 'Gen Matrix',
        hasPage: true,
        appBlockId: 'blk_gen-matrix',
      }),
    ];
    seedOwnedRecents([{ id: 'blk_gen-matrix', slug: 'gen-matrix', name: 'Gen Matrix' }]);

    renderWithProviders(<AppListingsMarketplaceBody />);

    const action = page.getByTestId('apps-recent-rail-action');
    await expect.element(action).toBeInTheDocument();
    await expect.element(action).toHaveAttribute('href', '/apps/run/gen-matrix');
  });
});
