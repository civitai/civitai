/**
 * `/apps` store — THE SKELETON ⇄ CARD BOX PARITY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING GUARDED
 * ─────────────────────────────────────────────────────────────────────────────
 * The store's loading state used to be `<Center py="xl"><Loader /></Center>` — a
 * spinner in a box with no relationship to the grid that replaced it, so every
 * cell in the store moved when the query resolved. It is now a grid of
 * `AppListingCardSkeleton`s rendered into the SAME `.gridContainer` / `.grid`
 * markup.
 *
 * "The same markup" is a claim about CSS classes; what a viewer experiences is a
 * claim about BOXES. So this file renders the real `AppListingsMarketplaceBody`
 * TWICE at the same grid width — once with the query loading, once resolved — and
 * compares each cell's `top` / `left` / `width` / `height`. Anything less (a
 * `getComputedStyle` check, an assertion that both render `.grid`) type-checks
 * straight past a skeleton that is 20px short.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE `geometry` PROJECT AND NOT `component`
 * ─────────────────────────────────────────────────────────────────────────────
 * The card's box depends on `h-full` (a Tailwind utility) resolving against
 * Mantine's `Card` rules and this repo's CSS module — a three-way cascade fight —
 * and on the grid STRETCHING its items. `test/component-setup.tsx` injects only
 * `globals.css`'s unconditional `:root` custom properties into a throwaway sheet,
 * so Tailwind utilities are inert in that tier by default: `className="flex"`
 * computes `display: block`. Three specs opt in with a side-effect
 * `import '~/styles/globals.css'`, and even those lack `test/cascade-layer-order.css`
 * and the six `@mantine/<pkg>/styles.layer.css` sheets, so they render under a cascade
 * matching neither the tier default nor production.
 *
 * That is not theory here. The sibling `AppListingsMarketplaceBody.stretch.geometry.test.tsx`
 * records its first draft living in the `component` tier and reporting heights of
 * `[458.23, 312.75, 434.23, 312.75]` on a CORRECT grid, because `h-full` did
 * nothing there — a test that cannot distinguish the fix from the defect. This file
 * therefore asserts `cascadeEvidence()` before it asserts anything about boxes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE FIXTURE IS PART OF THE CLAIM — READ THIS BEFORE QUOTING A RESULT
 * ─────────────────────────────────────────────────────────────────────────────
 * The skeleton reserves the card's INVARIANT parts: the 16:9 cover, the icon, the
 * two RESERVED title lines, the creator line and the always-rendered recommend
 * rollup line, plus the 46px action row. A card can also render a `line-clamp-3`
 * tagline, a Beta badge and an owner-only "Incomplete" badge — none of which a
 * loading state can predict.
 *
 * So the fixture below is a listing of exactly that invariant shape: a creator, no
 * tagline, not beta, viewed signed-out. What this file proves is "the invariant box
 * matches EXACTLY", NOT "no card ever moves". A listing carrying a tagline is
 * taller than its skeleton and the grid still resizes — stated in the component's
 * header and in the PR body rather than papered over here.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, cascadeEvidence, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * A listing of the shape the skeleton reserves.
 *
 * 🔴 THE VALUES ARE PAIRWISE DISTINCT AND SHARE NOTHING WITH ANY CONSTANT THE
 * ASSERTIONS NAME. Names are of different lengths so the fixture is not
 * accidentally uniform in a way that could hide a width bug, and no field spells
 * 2, 10, 36, 40, 46, 16 or 9 — a fixture that can only ever produce a constant's
 * own value cannot see a mutant that hardcodes the literal.
 */
function makeCard(id: string, name: string, creator: string): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name,
    // 🔴 `null`, not `''`. The card renders the tagline conditionally and the
    // skeleton reserves nothing for it — see the fixture note in the header.
    tagline: null,
    category: null,
    contentRating: null,
    isBeta: false,
    iconUrl: null,
    coverUrl: null,
    creator: { id: 7331, username: creator, image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    kindData: {
      kind: 'onsite',
      appBlockId: `blk-${id}`,
      hasPage: false,
      liveUrl: `https://slug-${id}.civit.ai`,
    },
  };
}

/** Enough distinct listings to fill two rows at the widest count measured here. */
const POOL: ListingCard[] = [
  makeCard('u1', 'Prompt Vault', 'ashling'),
  makeCard('u2', 'Gen Matrix Studio', 'bertrand'),
  makeCard('u3', 'Palette', 'cyd'),
  makeCard('u4', 'Frame Weaver Pro', 'delphine'),
  makeCard('u5', 'Nudge', 'esben'),
  makeCard('u6', 'Contour Lab', 'fitzgerald'),
  makeCard('u7', 'Stipple', 'greta'),
  makeCard('u8', 'Rehearsal Room', 'hollis'),
  makeCard('u9', 'Kerf', 'imogen'),
  makeCard('u10', 'Sable Notebook', 'jarrah'),
  makeCard('u11', 'Tessellate', 'kestrel'),
  makeCard('u12', 'Overtone Bench', 'linnea'),
];

const mocks = vi.hoisted(() => ({ items: [] as ListingCard[], isLoading: false }));

// The same mock set, and the same reasons, as
// `AppListingsMarketplaceBody.stretch.geometry.test.tsx` — see the long notes in
// `AppListingsMarketplaceBody.browser.test.tsx`. In short: the card reads
// `useCurrentUser`, the filters dropdown reads `useIsClient` + `useIsMobile` and both
// THROW without a provider, and the flags factory must name BOTH flag hooks or the
// whole file fails to IMPORT and reports `no tests` rather than a failure.
// `next/router` is already mocked by `test/geometry-setup.tsx`.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
  useFeatureFlagsReady: () => true,
}));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock).
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: {
        useInfiniteQuery: () => ({
          // 🔴 `data` IS UNDEFINED WHILE LOADING, as it is in production before the
          // first page arrives. Handing back items AND `isLoading: true` would let
          // a body that renders the grid regardless still look correct.
          data: mocks.isLoading
            ? undefined
            : { pages: [{ items: mocks.items, nextCursor: undefined }] },
          isLoading: mocks.isLoading,
          isError: false,
          isPlaceholderData: false,
          isFetchingNextPage: false,
          refetch: vi.fn(),
          fetchNextPage: vi.fn(),
          hasNextPage: false,
        }),
      },
    },
    blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } },
  },
}));

// Import AFTER the mocks (vi.mock is hoisted; static imports are not).
const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');
const { APP_LISTING_SKELETON_ROWS } = await import('./AppListingCardSkeleton');
const { listingGridColumnsAt } = await import('./appListingGrid');

/**
 * A viewport wide enough that neither grid width below is clamped by it. The grid
 * width is set on a wrapper, so the viewport is deliberately NOT the variable
 * under test.
 */
const VIEWPORT = { width: 2880, height: 900 } as const;

/**
 * TWO column counts, both NAMED in every assertion, because one measurement is
 * not a general claim.
 *
 * 1376 is mid-band in the four-column rung (the `xl` low end); 2450 is mid-band in
 * the five-column rung. 🔴 2364 — the five-column threshold itself — is
 * deliberately avoided: a fixture sitting on its own boundary cannot detect an
 * off-by-one, and the ladder's rungs are asserted against below so this cannot rot
 * into a coincidence.
 */
const WIDTHS = [
  { gridWidth: 1376, columns: 4 },
  { gridWidth: 2450, columns: 5 },
] as const;

/** The ladder's rungs, so a fixture can be checked against them. */
const RUNGS = [736, 960, 1168, 2364, 2840];

/**
 * Render the store body at an explicit grid width and hand back the cells of
 * whichever grid it decided to render.
 *
 * 🔴 CLEAN FIRST, ALWAYS. `vitest-browser-react` APPENDS each render rather than
 * replacing it, and the setup file's `afterEach` runs only BETWEEN tests — so a
 * test that renders twice leaves two grids in the document and
 * `document.querySelectorAll` keeps returning the FIRST one's cells. This file
 * renders twice in EVERY test, so without this every parity assertion would be
 * comparing a tree to itself and would pass unconditionally. The same defect was
 * found and fixed in two sibling suites; `the harness really replaces the tree`
 * below is the control that proves the cure works here.
 */
async function renderStore(gridWidth: number, opts: { loading: boolean; items?: ListingCard[] }) {
  await cleanup();
  mocks.isLoading = opts.loading;
  mocks.items = opts.items ?? [];
  const { observed } = await renderAtViewport(
    <div style={{ width: gridWidth, maxWidth: 'none' }} data-testid="width-harness">
      <AppListingsMarketplaceBody />
    </div>,
    VIEWPORT
  );
  await nextLayout();
  const selector = opts.loading ? 'apps-listing-skeleton-col' : 'apps-listing-grid-col';
  const gridId = opts.loading ? 'apps-listing-skeleton-grid' : 'apps-listing-grid';
  const grid = document.querySelector(`[data-testid="${gridId}"]`) as HTMLElement | null;
  const cells = Array.from(
    document.querySelectorAll(`[data-testid="${selector}"]`)
  ) as HTMLElement[];
  if (!grid) throw new Error(`${gridId} did not render (loading=${opts.loading})`);
  return {
    observed,
    grid,
    cells,
    boxes: cells.map((c) => box(c)),
    gridWidth: Math.round(grid.getBoundingClientRect().width),
  };
}

beforeEach(() => {
  mocks.items = [];
  mocks.isLoading = false;
});

describe('🔴 a skeleton cell occupies EXACTLY the box the card cell will', () => {
  test('the harness loaded the REAL cascade (positive control — Tailwind must resolve)', async () => {
    // 🔴 THE CONTROL THIS FILE EXISTS BECAUSE OF. Without Tailwind's utilities
    // `h-full` is inert, both grids' heights follow their content, and the
    // comparison below would be between two DIFFERENT wrong layouts that might
    // still happen to agree. `tailwindFlexUtilityResolves` is `false` under the
    // `component` tier's default setup and `true` here, so it is evidence rather
    // than a reassurance.
    await renderStore(2450, { loading: true });
    const evidence = cascadeEvidence();
    expect(
      evidence.tailwindFlexUtilityResolves,
      'Tailwind utilities did not resolve — the real cascade did not load'
    ).toBe(true);
    expect(evidence.probeBoxSizing, 'Preflight did not load').toBe('border-box');
    expect(evidence.ruleCount, 'the cascade is far too small to be the real one').toBeGreaterThan(
      1000
    );
  });

  test.each(WIDTHS)(
    'at $gridWidth px of grid ($columns columns) every skeleton box equals its card box',
    async ({ gridWidth, columns }) => {
      // ── ARM 1: LOADING ────────────────────────────────────────────────────
      const loading = await renderStore(gridWidth, { loading: true });
      expect(loading.observed).toEqual({ width: VIEWPORT.width, height: VIEWPORT.height });
      expect(loading.gridWidth, 'the harness did not size the grid as asked').toBe(gridWidth);

      // The count is the thing the skeleton grid decides for itself, so assert it
      // against the ladder rather than against a number typed here twice.
      expect(
        loading.cells.length,
        `at ${gridWidth}px the skeleton grid rendered ${loading.cells.length} cells; ` +
          `${APP_LISTING_SKELETON_ROWS} rows at ${columns} columns is ` +
          `${columns * APP_LISTING_SKELETON_ROWS}`
      ).toBe(columns * APP_LISTING_SKELETON_ROWS);
      expect(listingGridColumnsAt(gridWidth)).toBe(columns);

      // ── ARM 2: RESOLVED, with EXACTLY as many listings as there were cells ──
      // Same count, so any difference in a box is a difference in the CELL, never
      // a difference in how many rows the grid has.
      const items = POOL.slice(0, loading.cells.length);
      expect(items, 'the fixture pool is too small for this column count').toHaveLength(
        loading.cells.length
      );
      const resolved = await renderStore(gridWidth, { loading: false, items });
      expect(resolved.gridWidth).toBe(gridWidth);
      expect(resolved.cells).toHaveLength(loading.cells.length);

      // 🔴 NON-VACUITY: the boxes must be real boxes. A pair of collapsed
      // zero-height trees would compare equal and prove nothing.
      for (const b of [...loading.boxes, ...resolved.boxes]) {
        expect(b.width, 'a cell has no width — the grid did not lay out').toBeGreaterThan(100);
        expect(b.height, 'a cell has no height — the grid did not lay out').toBeGreaterThan(100);
      }

      // ── THE ASSERTION ─────────────────────────────────────────────────────
      expect(
        loading.boxes,
        `at ${gridWidth}px of grid (${columns} columns) a skeleton cell does not occupy the ` +
          'box its card will. Every cell in the store therefore MOVES when the query ' +
          'resolves — which is the entire defect the skeleton exists to remove. Compare ' +
          `skeleton ${JSON.stringify(loading.boxes[0])} with card ` +
          `${JSON.stringify(resolved.boxes[0])}.`
      ).toEqual(resolved.boxes);
    }
  );

  /**
   * Guard-the-guard #1: the two widths really are different column counts, and
   * neither sits on a rung. A pair resolving to the SAME count would test one
   * shape twice and nothing above would notice.
   */
  test('the two widths really are different column counts, and neither sits on a rung', async () => {
    const a = await renderStore(WIDTHS[0].gridWidth, { loading: true });
    const b = await renderStore(WIDTHS[1].gridWidth, { loading: true });
    expect(a.cells.length).toBe(WIDTHS[0].columns * APP_LISTING_SKELETON_ROWS);
    expect(b.cells.length).toBe(WIDTHS[1].columns * APP_LISTING_SKELETON_ROWS);
    expect(a.cells.length).not.toBe(b.cells.length);
    for (const { gridWidth } of WIDTHS) {
      for (const rung of RUNGS) {
        expect(gridWidth, `fixture ${gridWidth} sits exactly on the ${rung} rung`).not.toBe(rung);
      }
    }
  });

  /**
   * 🔴 Guard-the-guard #2: THE HARNESS REALLY REPLACES THE TREE.
   *
   * `vitest-browser-react` appends. If `renderStore`'s `cleanup()` were dropped,
   * the second render's `querySelectorAll` would return the FIRST render's cells
   * and every parity assertion above would be comparing a tree to itself — green,
   * unconditionally, forever. This proves two renders give two answers, which is
   * the property the whole file rests on.
   */
  test('🔴 two renders give two answers — the parity comparison is not a tree against itself', async () => {
    const narrow = await renderStore(WIDTHS[0].gridWidth, { loading: true });
    const wide = await renderStore(WIDTHS[1].gridWidth, { loading: true });
    expect(narrow.boxes[0].width).not.toBe(wide.boxes[0].width);
    // …and only ONE grid is in the document at a time, which is the mechanism.
    expect(document.querySelectorAll('[data-testid="apps-listing-skeleton-grid"]')).toHaveLength(1);
  });

  /**
   * The reason the cells can be compared positionally at all: the store renders
   * the SAME control row above both grids, so cell 0's `top` is not being compared
   * across two different page layouts.
   */
  test('both states render the same chrome above the grid, so `top` is comparable', async () => {
    const loading = await renderStore(2450, { loading: true });
    const loadingRow = box(
      document.querySelector('[data-testid="apps-store-control-row"]') as HTMLElement
    );
    const resolved = await renderStore(2450, { loading: false, items: POOL.slice(0, 10) });
    const resolvedRow = box(
      document.querySelector('[data-testid="apps-store-control-row"]') as HTMLElement
    );
    expect(loadingRow).toEqual(resolvedRow);
    expect(loading.boxes[0].top).toBe(resolved.boxes[0].top);
  });
});
