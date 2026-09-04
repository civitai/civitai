/**
 * `/apps` store grid — THE CARD-STRETCH SEAM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING GUARDED, AND WHY IT IS A SEAM RATHER THAN A COMPONENT TEST
 * ─────────────────────────────────────────────────────────────────────────────
 * `AppListingCard` bottom-pins its action row with `mt="auto"`, inside a
 * `<Stack h="100%">`, inside a `<Card className="h-full">`. None of that chain
 * resolves to a real height on its own: `h-full` is `height: 100%`, which needs a
 * parent with a definite height, and the only thing that gives it one is the GRID
 * stretching its items to the row's height — i.e. `align-items: normal`, the
 * default for a grid container.
 *
 * That default is declared NOWHERE. `AppListingsMarketplaceBody.module.scss` sets
 * no `align-items` on `.grid`, so the behaviour every card depends on is an
 * absence, and an absence reads as an omission nobody chose.
 *
 * 🔴 THE FOUR SHAPES, MEASURED. This grid is the FAILING one's first half — it
 * renders `.grid` → a per-card WRAPPER `<div data-testid="apps-listing-grid-col">`
 * → the card:
 *
 *   card as a DIRECT grid item, default align   ✅ bottoms equal, heights equal
 *   card in a WRAPPER div,      default align   ✅ bottoms equal, heights equal
 *   card as a DIRECT grid item, `align: start`  ✅ `h-full` resolves against the
 *                                                  grid AREA, so stretch is not
 *                                                  what carries it
 *   card in a WRAPPER div,      non-stretch     ❌ short card 40px shorter, its
 *                                                  action row unpinned
 *
 * So ONE line — `align-items: start` on `.grid`, the kind of thing someone adds
 * for vertical rhythm — silently unpins the action row on every card in the store.
 * Neither this grid's suite nor the card's own suite could see it: a structural
 * check ("does the action row carry `margin-top: auto`?") type-checks straight
 * past it, because the declaration is still there under the mutant — it simply has
 * no free space to consume. Only the rendered boxes can tell you.
 *
 * The seam is a RELATIONSHIP between two files owned by different changes, so it
 * is guarded as one: uneven cards, one row, equal heights, aligned action rows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE `geometry` PROJECT AND NOT `component`
 * ─────────────────────────────────────────────────────────────────────────────
 * `h-full` IS A TAILWIND UTILITY. The `component` tier's setup injects only the
 * `:root` custom properties out of `globals.css` — measured, 24 CSS rules — so
 * every Tailwind utility there is inert and the card's height silently follows its
 * content. This was not theory: the first draft of this guard lived in
 * `AppListingsMarketplaceBody.columns.browser.test.tsx` and reported heights of
 * `[458.23, 312.75, 434.23, 312.75]` on a CORRECT grid, because `h-full` did
 * nothing. A test that cannot distinguish the fix from the defect is worse than no
 * test, and it would have been read as this guard working.
 *
 * `test/geometry-setup.tsx` loads the real cascade in production order and this
 * file asserts that it arrived (`cascadeEvidence()`), so a stylesheet that fails
 * to load fails the run rather than quietly reproducing the defect's numbers.
 *
 * The column LADDER stays in the `component` tier — it is driven by this repo's own
 * CSS module, which Vite injects wherever the component is imported, so it needs no
 * app cascade. Only the stretch chain does.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { cascadeEvidence, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import type * as TrpcMod from '~/utils/trpc';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';

function makeCard(id: string, name: string, tagline: string | null): ListingCard {
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
    kindData: {
      kind: 'onsite',
      appBlockId: `blk-${id}`,
      hasPage: false,
      liveUrl: `https://slug-${id}.civit.ai`,
    },
  };
}

const mocks = vi.hoisted(() => ({ items: [] as ListingCard[] }));

// Same mock set, and the same reasons, as the sibling `.browser.test.tsx` files — see
// the long notes in `AppListingsMarketplaceBody.browser.test.tsx`. In short: the card
// reads `useCurrentUser`, the filters dropdown reads `useIsClient` + `useIsMobile` and
// both THROW without a provider, and the flags factory must name BOTH flag hooks or the
// whole file fails to IMPORT and reports `no tests` rather than a failure.
// `next/router` is already mocked by `test/geometry-setup.tsx`.
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

/**
 * Deliberately UNEVEN content, ALTERNATING so that any prefix of two or more holds both
 * kinds: a one-line title with NO tagline against a wrapping title with a three-line one.
 * `AppListingCard` renders its tagline conditionally, so the short cards are genuinely
 * shorter — which the `contentBottom` control below ASSERTS rather than assumes.
 */
const TALL_TAGLINE =
  'A deliberately long tagline that wraps onto three separate lines inside a store card ' +
  'column so that this card is measurably taller than its neighbour, which has no ' +
  'tagline at all and only a single short line of title text.';

const MIXED: ListingCard[] = [
  makeCard('t0', 'A Very Long Application Name That Wraps Across Several Lines', TALL_TAGLINE),
  makeCard('s1', 'App 1', null),
  makeCard('t2', 'Another Long Application Name That Also Wraps Across Lines', TALL_TAGLINE),
  makeCard('s3', 'App 3', null),
  makeCard('t4', 'A Third Long Application Name That Wraps Across Lines Too', TALL_TAGLINE),
];

/**
 * A viewport wide enough that neither grid width below is clamped by it. The grid width
 * is set on a wrapper, so the viewport is deliberately NOT the variable under test.
 */
const VIEWPORT = { width: 2880, height: 900 } as const;

/**
 * TWO column counts, both NAMED in every assertion.
 *
 * 1376 is the four-column band (the `xl` low end, and the collision guard the ladder
 * suite pins); 2450 is mid-band in the five-column rung. Neither sits on a ladder
 * threshold — 2364 itself is deliberately avoided, since a fixture on its own boundary
 * cannot detect an off-by-one. At 1376 the first row holds four of the five cards, at
 * 2450 all five; both prefixes contain at least one tall card and one short one.
 */
const WIDTHS = [
  { gridWidth: 1376, columns: 4 },
  { gridWidth: 2450, columns: 5 },
] as const;

/** The ladder's rungs, so a fixture can be checked against them. */
const RUNGS = [736, 960, 1168, 2364, 2840];

/** 2dp, so sub-pixel layout is visible but float noise is not. */
const q = (n: number) => Math.round(n * 100) / 100;

async function renderAtGridWidth(width: number) {
  // 🔴 CLEAN FIRST, ALWAYS. `vitest-browser-react` APPENDS each render rather than
  // replacing it, and the setup file's `afterEach` only runs BETWEEN tests — so a test
  // that renders twice leaves two grids in the document and `document.querySelector`
  // keeps returning the FIRST one. Measured here, not theorised: without this the
  // two-widths guard below read 4 columns for its 2450px render because it was still
  // looking at the 1376px grid. The same defect was found and fixed in
  // `AppListingsMarketplaceBody.columns.browser.test.tsx`, where it had silently made a
  // loop over two widths measure one width twice and pass.
  await cleanup();
  const { observed } = await renderAtViewport(
    <div style={{ width, maxWidth: 'none' }} data-testid="width-harness">
      <AppListingsMarketplaceBody />
    </div>,
    VIEWPORT
  );
  await nextLayout();
  const grid = document.querySelector('[data-testid="apps-listing-grid"]') as HTMLElement | null;
  const cells = Array.from(
    document.querySelectorAll('[data-testid="apps-listing-grid-col"]')
  ) as HTMLElement[];
  if (!grid || cells.length === 0) {
    throw new Error(`grid not rendered (grid=${!!grid} cells=${cells.length})`);
  }
  return { observed, grid, cells, gridWidth: Math.round(grid.getBoundingClientRect().width) };
}

/**
 * The parts of one rendered card this file measures.
 *
 * 🔴 RESOLVED STRUCTURALLY, AND THEN VALIDATED, because `AppListingCard` carries no
 * `data-testid` on its action row and this file must not add one: that component is owned
 * by a concurrent change, and the coupling under test is pre-existing on `main`. So the
 * resolver walks my own grid cell → the `Card` → the body `Stack` → its LAST child. Each
 * step is then checked against something only the real action row satisfies, and a failed
 * check THROWS with the offending `outerHTML` rather than returning a wrong element — a
 * silently mis-resolved element would make every assertion below compare the wrong boxes
 * and pass.
 */
function cardPartsOf(cell: HTMLElement) {
  const card = cell.firstElementChild as HTMLElement | null;
  if (!card) throw new Error(`grid cell has no card child: ${cell.outerHTML.slice(0, 200)}`);
  const stack = card.lastElementChild as HTMLElement | null;
  if (!stack) throw new Error(`card has no body stack: ${card.outerHTML.slice(0, 200)}`);
  const actionRow = stack.lastElementChild as HTMLElement | null;
  if (!actionRow) throw new Error(`card body has no last child: ${stack.outerHTML.slice(0, 200)}`);
  // VALIDATION 1 — the action row is the one holding the card's controls. The title block
  // above it holds a link too, so this does not identify it alone; it is what rules out
  // having resolved to a `<Text>` tagline.
  if (actionRow.querySelectorAll('a[href], button').length === 0) {
    throw new Error(
      'resolved "action row" holds no link or button — the walk found the wrong element: ' +
        actionRow.outerHTML.slice(0, 300)
    );
  }
  // VALIDATION 2 — it really is the LAST thing in the card body, which is what makes "its
  // top" a meaningful proxy for "where the pinned row sits".
  if (actionRow.nextElementSibling !== null) {
    throw new Error('resolved "action row" is not the last child of the card body');
  }
  // Where the content ABOVE the action row ends. This is the NON-VACUITY CONTROL: the
  // fixtures must genuinely differ in natural content height, or "the heights are equal"
  // is a fact about identical cards rather than about stretching. It is unaffected by the
  // auto margin, so it still differs while the stretch is working.
  const lastContent = actionRow.previousElementSibling as HTMLElement | null;
  return {
    card,
    actionRow,
    cardHeight: q(card.getBoundingClientRect().height),
    cardBottom: q(card.getBoundingClientRect().bottom),
    actionRowBottom: q(actionRow.getBoundingClientRect().bottom),
    actionRowTop: q(actionRow.getBoundingClientRect().top),
    contentBottom: lastContent ? q(lastContent.getBoundingClientRect().bottom) : null,
  };
}

/** The cells sharing the FIRST visual row, in visual order. */
function firstRowCells(cells: HTMLElement[]): HTMLElement[] {
  const tops = cells.map((c) => Math.round(c.getBoundingClientRect().top));
  const first = Math.min(...tops);
  return cells.filter((_, i) => tops[i] === first);
}

beforeEach(() => {
  mocks.items = MIXED;
});

describe('🔴 the store grid stretches its cards, so their action rows stay pinned', () => {
  test('the harness loaded the REAL cascade (positive control — Tailwind must resolve)', async () => {
    // 🔴 THE CONTROL THIS FILE EXISTS BECAUSE OF. Without Tailwind's utilities `h-full` is
    // inert, the card's height follows its content, and every measurement below reproduces
    // the DEFECT's numbers on correct code. `tailwindFlexUtilityResolves` is `false` in the
    // `component` tier and `true` here, so it is evidence rather than a reassurance.
    await renderAtGridWidth(2450);
    const evidence = cascadeEvidence();
    expect(evidence.tailwindFlexUtilityResolves, 'Tailwind utilities are inert here').toBe(true);
    expect(evidence.probeBoxSizing, 'Preflight did not load').toBe('border-box');
    expect(evidence.ruleCount, 'the cascade is far too small to be the real one').toBeGreaterThan(
      1000
    );
    // …and the specific declaration the whole seam hangs on actually applies.
    const card = document.querySelector('[data-testid="apps-listing-grid-col"] > *') as HTMLElement;
    expect(getComputedStyle(card).height).not.toBe('auto');
  });

  test.each(WIDTHS)(
    'at $gridWidth px of grid ($columns columns) every card in the row is the same height, and the action rows align',
    async ({ gridWidth, columns }) => {
      const m = await renderAtGridWidth(gridWidth);
      expect(m.observed).toEqual({ width: VIEWPORT.width, height: VIEWPORT.height });
      expect(m.gridWidth, 'the harness did not size the grid as asked').toBe(gridWidth);
      expect(m.cells).toHaveLength(MIXED.length);

      const row = firstRowCells(m.cells);
      expect(row, `expected a full ${columns}-column first row at ${gridWidth}px`).toHaveLength(
        columns
      );
      const parts = row.map(cardPartsOf);

      // 🔴 THE NON-VACUITY CONTROL, ASSERTED FIRST. Equal heights prove nothing if the
      // fixtures are the same height to begin with, so the natural content must genuinely
      // differ. If this ever goes green-by-uniformity the two assertions below become
      // decorative, and this is what says so.
      const contentBottoms = parts.map((p) => p.contentBottom);
      expect(
        new Set(contentBottoms).size,
        `at ${gridWidth}px the fixtures do not differ in content height ` +
          `(${JSON.stringify(contentBottoms)}) — the assertions below would pass on ` +
          'identical cards and would be testing nothing'
      ).toBeGreaterThan(1);

      // (a) EQUAL HEIGHTS.
      const heights = parts.map((p) => p.cardHeight);
      expect(
        new Set(heights).size,
        `at ${gridWidth}px of grid (${columns} columns) the cards in one row have different ` +
          `heights ${JSON.stringify(heights)}. The grid stopped stretching its items — check ` +
          'that `.grid` in AppListingsMarketplaceBody.module.scss still declares NO ' +
          '`align-items`. The cards sit in a wrapper div, so any non-stretch value makes the ' +
          "card's `h-full` resolve against its content instead of the row."
      ).toBe(1);

      // (b) ALIGNED ACTION ROWS — the effect the equal heights exist to buy, and the one a
      // viewer actually sees.
      const actionTops = parts.map((p) => p.actionRowTop);
      expect(
        new Set(actionTops).size,
        `at ${gridWidth}px of grid (${columns} columns) the bottom-pinned action rows do not ` +
          `align ${JSON.stringify(actionTops)}. The card's \`mt="auto"\` has no free space ` +
          'to consume, i.e. the card is no longer as tall as its row.'
      ).toBe(1);

      // …and they are pinned to the BOTTOM rather than merely agreeing somewhere in the
      // middle: every action row ends at the same distance from its card's bottom edge,
      // which is the Card's own padding.
      const bottomGaps = parts.map((p) => q(p.cardBottom - p.actionRowBottom));
      expect(
        new Set(bottomGaps).size,
        `action rows sit at different distances from their card bottoms ${JSON.stringify(
          bottomGaps
        )}`
      ).toBe(1);
    }
  );

  test('the two widths really are different column counts, and neither sits on a rung', async () => {
    // Guard-the-guard: a pair of widths resolving to the SAME column count would test one
    // shape twice, and `firstRowCells` would still return a full row so nothing above
    // would notice.
    const a = await renderAtGridWidth(WIDTHS[0].gridWidth);
    const aCols = firstRowCells(a.cells).length;
    const b = await renderAtGridWidth(WIDTHS[1].gridWidth);
    const bCols = firstRowCells(b.cells).length;
    expect(aCols).toBe(WIDTHS[0].columns);
    expect(bCols).toBe(WIDTHS[1].columns);
    expect(aCols).not.toBe(bCols);
    for (const { gridWidth } of WIDTHS) {
      for (const rung of RUNGS) {
        expect(gridWidth, `fixture ${gridWidth} sits exactly on the ${rung} rung`).not.toBe(rung);
      }
    }
  });

  test('🔴 the grid resolves to the STRETCHING value of `align-items`', async () => {
    // The cheap half, beside the expensive one, so a reader who changes the stylesheet
    // meets the reason immediately. Read off the LIVE grid rather than the source text, so
    // a value arriving from any other rule is caught too — and stated as the RESOLVED
    // value rather than as "the property is absent", because what matters is what the
    // layout engine ends up using.
    //
    // It is NOT sufficient on its own: `align-items` is one of several ways to break the
    // chain (a definite height on the wrapper would do it too), which is why the
    // measurements above exist. It is here because it names the exact line.
    const m = await renderAtGridWidth(2450);
    expect(
      getComputedStyle(m.grid).alignItems,
      'the store grid no longer stretches its items to the row height — the cards sit in a ' +
        "wrapper div, so this unpins every card's action row"
    ).toBe('normal');
  });
});
