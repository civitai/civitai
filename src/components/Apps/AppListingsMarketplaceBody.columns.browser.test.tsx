/**
 * `/apps` store grid — the RENDERED COLUMN LADDER.
 *
 * 🔴 WHAT ONLY THIS FILE CAN SEE. `__tests__/appListingGrid.test.ts` pins the ladder's
 * numbers and proves the stylesheet's `@container` rules equal them — but both halves of
 * that seam are TEXT. Neither can tell you that the container query resolves, that
 * `container-type: inline-size` was actually applied, that the rules survived the
 * cascade, or that the cards land on the number of rows the arithmetic says. Those are
 * pixel facts, and they are what this file measures.
 *
 * 🔴 COLUMNS ARE COUNTED BY `getBoundingClientRect().top`, NOT BY DOM CHILDREN. Counting
 * children tells you how many CARDS there are, which is a fact about the fixture and is
 * true whatever the stylesheet does — the classic assertion that cannot fail. Grouping
 * the cells by their rendered `top` asks the layout engine how many actually sit on a
 * visual row, which is the only form of the question that a broken container query can
 * answer differently.
 *
 * 🔴 WHY IT IMPORTS A STYLESHEET AND WHAT IT DELIBERATELY DOES NOT NEED.
 * `test/component-setup.tsx` injects only the `:root` custom properties out of
 * `globals.css` (24 CSS rules, per `test/geometry-setup.tsx`'s own record of 2026-09-03
 * — not re-measured here) — so by DEFAULT this tier resolves no Tailwind
 * utility and no Mantine rule. (Three specs opt in by importing `~/styles/globals.css`
 * themselves; this is not one of them, and does not need to be.) The column ladder lives
 * in a CSS MODULE, which Vite injects wherever the component is imported, so the
 * `@container` rules apply here regardless — what would NOT apply is Mantine's own
 * `display`/box rules, hence the one stylesheet imported above. The file then ASSERTS
 * the sheet arrived (`cascadeLoaded` below), because "every width rendered one column" is
 * exactly what an unstyled document produces and would read as a consistent, confident,
 * entirely vacuous pass.
 *
 * 🔴 WHAT THIS TIER CANNOT MEASURE, AND WHERE THAT LIVES INSTEAD. Anything resolving
 * through Tailwind or through the production cascade-LAYER order — notably the card's
 * `h-full` + `h="100%"` + `mt="auto"` bottom-pin chain — is not measurable here. That
 * seam is guarded in `AppListingsMarketplaceBody.stretch.geometry.test.tsx`, in the
 * `geometry` project, which loads the layer-order declaration and the Mantine layer
 * sheets in production order. A first draft of it lived in THIS file and reported card
 * heights of `[458.23, 312.75, 434.23, 312.75]` on a correct grid.
 *
 * ⚠️ REPORT-ONLY, like every `.browser.test.tsx` here: the `component` project's only CI
 * home is the preview pipeline's non-blocking `preview / component-tests`. The gating
 * half of this change lives in the `unit` project.
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

function makeCard(id: string, name: string, tagline: string | null = 'tag'): ListingCard {
  return {
    id,
    slug: `slug-${id}`,
    kind: 'onsite',
    name,
    tagline,
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

const mocks = vi.hoisted(() => ({ items: [] as ListingCard[] }));

// Same mock set, and the same reasons, as `AppListingsMarketplaceBody.browser.test.tsx`
// — see the long notes there. In short: the card reads `useCurrentUser`, the filters
// dropdown reads `useIsClient` + `useIsMobile` and both THROW without a provider, and
// the flags factory must name BOTH flag hooks or the whole file fails to import and
// reports `no tests` rather than a failure.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: false }),
}));
// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock).
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

// Import AFTER the mocks (vi.mock is hoisted; static imports are not).
const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');
const { LISTING_CARD_MIN_WIDTH, listingGridColumnsAt } = await import('./appListingGrid');

/**
 * Enough cards that a full row exists at EVERY width under test, including six columns,
 * with a second row to prove the grid wraps rather than overflowing on one line.
 */
const CARD_COUNT = 13;

/**
 * A viewport wide enough that none of the fixture widths below is clamped by it. The
 * container widths are set explicitly on a wrapper, so the viewport is deliberately NOT
 * the variable under test — that is the whole point of using a container query.
 */
const VIEWPORT = { width: 2880, height: 900 } as const;

/**
 * Render the store body inside a wrapper of an EXPLICIT width, and report what actually
 * laid out.
 *
 * The wrapper is the grid's width, which is the quantity the container query reads. In
 * production that width comes from `AppsPageLayout`'s Container; here it is set directly,
 * so the fixture varies exactly one thing.
 */
async function renderAtContainerWidth(width: number) {
  // 🔴 CLEAN FIRST, ALWAYS — a test that measures more than one width is the whole point
  // of this file, and `vitest-browser-react` APPENDS each render rather than replacing
  // it. Without this the second call leaves TWO grids in the document, `getByText`
  // throws a strict-mode violation, and — far worse — `document.querySelector` keeps
  // returning the FIRST (stale) grid, so a loop over widths measures the first width N
  // times and passes. That is exactly what an earlier version of the floor check below
  // did: it looped two widths, measured one, and was green.
  await cleanup();
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
  renderWithProviders(
    <div style={{ width, maxWidth: 'none' }} data-testid="width-harness">
      <AppListingsMarketplaceBody />
    </div>
  );
  // 🔴 SETTLE ON THE GRID CELL, NOT ON A CARD'S NAME. Two fixtures use this helper —
  // the uniform `App N` set and the deliberately uneven mixed-height set — so waiting on
  // `getByText('App 0')` bound the helper to one of them and made the other time out
  // 15s per test with a failure that reads like a broken component.
  await expect.element(page.getByTestId('apps-listing-grid-col').first()).toBeInTheDocument();
  // Two frames so style application and layout have both settled.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  const grid = document.querySelector('[data-testid="apps-listing-grid"]') as HTMLElement | null;
  const cells = Array.from(
    document.querySelectorAll('[data-testid="apps-listing-grid-col"]')
  ) as HTMLElement[];
  if (!grid || cells.length === 0) {
    throw new Error(`grid not rendered (grid=${!!grid} cells=${cells.length})`);
  }

  /**
   * 🔴 THE POSITIVE CONTROL. Without `@mantine/core/styles.css` + the CSS Module the
   * wrapper computes no layout of its own, the grid is a plain block, and EVERY width
   * reports one cell per row — a perfectly consistent set of wrong answers. `display:
   * grid` cannot be the UA default for a `<div>`, so reading it back is evidence the
   * stylesheet arrived rather than a value that would be there anyway.
   */
  const cascadeLoaded = getComputedStyle(grid).display === 'grid';

  // Group by rendered top, not by DOM position. Rounded to the nearest px so sub-pixel
  // layout differences within one row cannot split it into two.
  const rows = new Map<number, number>();
  for (const cell of cells) {
    const top = Math.round(cell.getBoundingClientRect().top);
    rows.set(top, (rows.get(top) ?? 0) + 1);
  }
  const perRow = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);

  return {
    cascadeLoaded,
    gridWidth: Math.round(grid.getBoundingClientRect().width),
    cellWidth: Math.round(cells[0].getBoundingClientRect().width * 100) / 100,
    /** How many cells sit on the FIRST visual row — i.e. the column count. */
    columns: perRow[0],
    perRow,
    cellCount: cells.length,
  };
}

beforeEach(() => {
  mocks.items = Array.from({ length: CARD_COUNT }, (_, i) => makeCard(`c${i}`, `App ${i}`));
});

/**
 * The measurement points.
 *
 * 🔴 NONE OF THEM SITS ON A THRESHOLD. The rungs are at 736 / 960 / 1168 / 2364 / 2840;
 * a fixture placed exactly on one would be the case where a one-pixel mutation of that
 * threshold does not change the outcome, so it would survive a fully green suite for the
 * wrong reason. Every width below overshoots into the middle of its band.
 *
 * 🔴 1376 AND 1888 ARE THE COLLISION GUARDS, RENDERED. The card-width floor is 460 and
 * `4 × 460 + 3 × 16 = 1888`, so a ladder whose narrow half was governed by the floor
 * would still render four columns at 1888 and would drop 1376 — the `xl` low end — to
 * three. 1888 is the reassuring one; 1376 is the one that catches it. The arithmetic
 * half of this lives in `__tests__/appListingGrid.test.ts`; this is the pixels.
 *
 * 2450 and 2560 are the new five-column band: 2450 is mid-band (deliberately not 2364,
 * the rung itself) and 2560 is what the change is nominally about. 2528 is what `/apps`
 * actually reaches at a 2560 container, so it is measured too rather than inferred.
 * 1000 is the unchanged narrow case.
 */
const CASES = [
  { containerWidth: 1000, columns: 3, why: 'unchanged narrow case — the md band' },
  { containerWidth: 1376, columns: 4, why: '🔴 COLLISION GUARD — the xl low end (1408 − 32)' },
  { containerWidth: 1888, columns: 4, why: '🔴 COLLISION GUARD — exactly 4 × 460 + 3 × 16' },
  { containerWidth: 2450, columns: 5, why: 'mid-band in the new five-column rung' },
  { containerWidth: 2528, columns: 5, why: 'what /apps reaches at a 2560 container' },
  { containerWidth: 2560, columns: 5, why: 'a 2560-wide grid — five, not six' },
] as const;

describe('the store grid renders the column ladder it declares', () => {
  test.each(CASES)(
    'a $containerWidth px grid renders $columns columns per row ($why)',
    async ({ containerWidth, columns }) => {
      const m = await renderAtContainerWidth(containerWidth);
      expect(
        m.cascadeLoaded,
        'the stylesheet did not load — every count below is meaningless'
      ).toBe(true);
      expect(m.gridWidth, 'the harness did not size the grid as asked').toBe(containerWidth);
      expect(m.cellCount).toBe(CARD_COUNT);
      expect(m.columns).toBe(columns);
      // The row shape as a whole, so a grid that put N on the first row and then
      // collapsed cannot pass. 13 cards at C columns = full rows plus a remainder.
      const full = Math.floor(CARD_COUNT / columns);
      const remainder = CARD_COUNT % columns;
      expect(m.perRow).toEqual([
        ...Array.from({ length: full }, () => columns),
        ...(remainder ? [remainder] : []),
      ]);
      // …and the constants agree with the browser about what should have happened.
      expect(listingGridColumnsAt(containerWidth)).toBe(columns);
    }
  );

  test('🔴 the new WIDE rung really does clear the card-width floor, measured', async () => {
    // The floor is arithmetic in the unit tier. Here it is a rendered box: the five-column
    // band must leave every card at least as wide as the four-up the 1920 container
    // shipped — that is the whole product decision behind the 460 floor.
    for (const containerWidth of [2450, 2528, 2560]) {
      const m = await renderAtContainerWidth(containerWidth);
      expect(m.cascadeLoaded).toBe(true);
      expect(
        m.cellWidth,
        `${m.columns} columns at ${containerWidth}px gave ${m.cellWidth}px cards`
      ).toBeGreaterThanOrEqual(LISTING_CARD_MIN_WIDTH);
    }
  });

  test('🔴 widening the page makes cards BIGGER than the 1920 container did, measured', async () => {
    // The direction, not just the threshold. `/apps` at a 2560 container renders 2528 of
    // grid; the old 1920 container rendered 1888 at four columns = 460px. The new layout
    // must beat that, or the ultrawide pass has partially reversed the larger-covers one
    // at exactly the viewports it exists to help.
    const old1920 = await renderAtContainerWidth(1888);
    expect(old1920.cascadeLoaded).toBe(true);
    expect(old1920.columns).toBe(4);
    expect(old1920.cellWidth).toBe(460);

    const now2560 = await renderAtContainerWidth(2528);
    expect(now2560.cascadeLoaded).toBe(true);
    expect(now2560.columns).toBe(5);
    expect(now2560.cellWidth).toBe(492.8);
    expect(now2560.cellWidth).toBeGreaterThan(old1920.cellWidth);
  });

  test('🔴 SIX columns is unreachable at the container cap, measured', async () => {
    // The rung is declared at 2840 and the container tops out at 2528. Rendering AT the
    // cap must give five; rendering past the rung must give six — which proves the rung
    // is real rather than decorative, and that the ladder is 4/5 today by ARITHMETIC
    // rather than because six was deleted.
    const atCap = await renderAtContainerWidth(2528);
    expect(atCap.cascadeLoaded).toBe(true);
    expect(atCap.columns).toBe(5);

    const pastRung = await renderAtContainerWidth(2900);
    expect(pastRung.cascadeLoaded).toBe(true);
    expect(pastRung.columns).toBe(6);
  });

  test('🔴 it is a CONTAINER query, not a media query (a narrow grid on a wide screen)', async () => {
    // THE DISCRIMINATING CASE, and the reason the viewport is held constant at 2880 for
    // every test in this file. A media-query implementation would read the VIEWPORT —
    // 2880, the top of the ladder — and render six columns into a 900px box, at 135px per
    // card. A container query reads the GRID and renders the two columns 900px earns
    // (900 sits in the sm band, 736–959).
    const m = await renderAtContainerWidth(900);
    expect(m.cascadeLoaded).toBe(true);
    expect(m.gridWidth).toBe(900);
    expect(window.innerWidth, 'the viewport must be far wider than the grid here').toBe(
      VIEWPORT.width
    );
    expect(m.columns, 'six columns here would mean the ladder is reading the viewport').toBe(2);
    expect(m.columns).toBe(listingGridColumnsAt(900));
    // Stated as the counterfactual too, so the test says what it is ruling out.
    expect(listingGridColumnsAt(VIEWPORT.width)).toBe(6);
  });

  test('🔴 the harness really re-renders — two widths in one test give two answers', async () => {
    // The control for the `cleanup()` above, and for every multi-width test in this file.
    // Without it these two calls return the SAME measurement and every such test passes
    // while measuring one width twice.
    const narrow = await renderAtContainerWidth(1000);
    const wide = await renderAtContainerWidth(2528);
    expect(narrow.gridWidth).toBe(1000);
    expect(wide.gridWidth).toBe(2528);
    expect(narrow.columns).not.toBe(wide.columns);
    // …and exactly one grid is in the document at a time, which is the mechanism.
    expect(document.querySelectorAll('[data-testid="apps-listing-grid"]')).toHaveLength(1);
  });

  test('the fixture set varies the dimension under test and covers both halves of the ladder', () => {
    // Guard-the-guard: a table of one width, or of several widths in one band, cannot see
    // a ladder bug at all.
    const widths = CASES.map((c) => c.containerWidth);
    expect(new Set(widths).size).toBe(widths.length);
    expect(new Set(CASES.map((c) => c.columns))).toEqual(new Set([3, 4, 5]));
    // And no fixture sits ON a rung — see the note above the table.
    for (const w of widths) {
      for (const rung of [736, 960, 1168, 2364, 2840]) {
        expect(w, `fixture ${w} sits exactly on the ${rung} rung`).not.toBe(rung);
      }
    }
    // 🔴 THE COLLISION GUARDS MUST BOTH BE PRESENT. 1888 alone is the reassuring half —
    // a floor-governed narrow half renders four there too — so a table that kept only
    // 1888 would read as covering this and would not.
    expect(widths, 'the xl-low-end collision guard was dropped').toContain(1376);
    expect(widths, 'the 4 × 460 + 3 × 16 collision guard was dropped').toContain(1888);
  });
});
