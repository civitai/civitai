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
 * 🔴 WHY IT IMPORTS THE CASCADE. `test/component-setup.tsx` injects only the `:root`
 * custom properties out of `globals.css` — measured, 24 CSS rules — so every Tailwind
 * utility is inert and, critically, a CSS-Module `@container` rule would still apply but
 * `display: grid` from an unloaded sheet would not. This file imports what it needs and
 * then ASSERTS it arrived (`cascadeLoaded` below), because "every width rendered one
 * column" is exactly what an unstyled document produces and it would read as a
 * consistent, confident, entirely vacuous pass.
 *
 * ⚠️ REPORT-ONLY, like every `.browser.test.tsx` here: the `component` project's only CI
 * home is the preview pipeline's non-blocking `preview / component-tests`. The gating
 * half of this change lives in the `unit` project.
 */
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

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
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
  renderWithProviders(
    <div style={{ width, maxWidth: 'none' }} data-testid="width-harness">
      <AppListingsMarketplaceBody />
    </div>
  );
  await expect.element(page.getByText('App 0')).toBeInTheDocument();
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
 * 🔴 NONE OF THEM SITS ON A THRESHOLD. The rungs are at 736 / 960 / 1168 / 1979 / 2378;
 * a fixture placed exactly on one would be the case where a one-pixel mutation of that
 * threshold does not change the outcome, so it would survive a fully green suite for the
 * wrong reason. Every width below overshoots into the middle of its band.
 *
 * 1888 / 2100 / 2560 are the three the change is ABOUT: 1888 is what the retired 1920
 * container reached (its column count must be unchanged), and 2100 / 2560 are the two
 * new rungs. 1000 is the unchanged narrow case.
 */
const CASES = [
  { containerWidth: 1000, columns: 3, why: 'unchanged narrow case — the md band' },
  { containerWidth: 1888, columns: 4, why: 'what the RETIRED 1920 container reached' },
  { containerWidth: 2100, columns: 5, why: 'the new five-column rung' },
  { containerWidth: 2560, columns: 6, why: 'the new six-column rung' },
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

  test('🔴 the new WIDE rungs really do clear the card-width floor, measured', async () => {
    // The floor is arithmetic in the unit tier. Here it is a rendered box: five and six
    // columns must both leave each card at least as wide as the covers pass shipped.
    for (const containerWidth of [2100, 2560]) {
      const m = await renderAtContainerWidth(containerWidth);
      expect(m.cascadeLoaded).toBe(true);
      expect(
        m.cellWidth,
        `${m.columns} columns at ${containerWidth}px gave ${m.cellWidth}px cards`
      ).toBeGreaterThanOrEqual(LISTING_CARD_MIN_WIDTH);
    }
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

  test('the fixture set varies the dimension under test and covers both halves of the ladder', () => {
    // Guard-the-guard: a table of one width, or of four widths in one band, cannot see a
    // ladder bug at all.
    const widths = CASES.map((c) => c.containerWidth);
    expect(new Set(widths).size).toBe(widths.length);
    expect(new Set(CASES.map((c) => c.columns))).toEqual(new Set([3, 4, 5, 6]));
    // And no fixture sits ON a rung — see the note above the table.
    for (const w of widths) {
      for (const rung of [736, 960, 1168, 1979, 2378]) {
        expect(w, `fixture ${w} sits exactly on the ${rung} rung`).not.toBe(rung);
      }
    }
  });
});
