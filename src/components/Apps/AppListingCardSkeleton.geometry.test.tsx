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
 * two RESERVED title lines, the 46px action row, and the always-rendered stats line
 * BELOW that row. A card can also render a `line-clamp-3` tagline, a Beta badge and
 * an owner-only "Incomplete" badge — none of which a loading state can predict.
 *
 * So the fixture below is a listing of exactly that invariant shape: no tagline, not
 * beta, viewed signed-out. What this file proves is "the invariant box matches
 * EXACTLY", NOT "no card ever moves". A listing carrying a tagline is taller than
 * its skeleton and the grid still resizes — stated in the component's header and in
 * the PR body rather than papered over here.
 *
 * 🔴 TWO THINGS THAT USED TO BE PART OF "THE INVARIANT SHAPE" NO LONGER ARE, AND
 * THAT IS THIS CHANGE'S WHOLE EFFECT ON THIS FILE (2026-09-06):
 *   · THE CREATOR. This paragraph used to open the fixture list with "a creator",
 *     because the skeleton reserved an author line the card only sometimes rendered
 *     — the one DOWNWARD variance axis. The card renders no author chip now, the
 *     skeleton reserves no such line, and `creator` no longer moves the box in
 *     either direction. Pinned as an equality by the retargeted "a card with NO
 *     CREATOR is EXACTLY its skeleton" test below.
 *   · THE KIND. The stats line carries a PLAY COUNT that an off-site listing omits
 *     (`openCount === null` — nothing on-platform observes a third-party CTA). That
 *     omission shares the rollup's flex line, so it costs WIDTH and not height —
 *     which is what lets the skeleton reserve one line without knowing a kind it
 *     structurally cannot know. Pinned by "an OFF-SITE card (no play count) is
 *     EXACTLY its skeleton too" below, because "it costs no height" is a
 *     measurement, not a promise.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import {
  box,
  cascadeEvidence,
  LOADABLE_IMAGE_DATA_URI,
  nextLayout,
  renderAtViewport,
} from '../../../test/geometry-setup';
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
    openCount: 0,
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

const mocks = vi.hoisted(() => ({
  items: [] as ListingCard[],
  isLoading: false,
  /** The signed-in viewer, or `null`. Drives whether a card renders the `⋮` trigger. */
  currentUser: null as { id: number; username: string } | null,
}));

// The same mock set, and the same reasons, as
// `AppListingsMarketplaceBody.stretch.geometry.test.tsx` — see the long notes in
// `AppListingsMarketplaceBody.browser.test.tsx`. In short: the card reads
// `useCurrentUser`, the filters dropdown reads `useIsClient` + `useIsMobile` and both
// THROW without a provider, and the flags factory must name BOTH flag hooks or the
// whole file fails to IMPORT and reports `no tests` rather than a failure.
// `next/router` is already mocked by `test/geometry-setup.tsx`.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
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
const { APP_LISTING_SKELETON_ROWS, gridQueryInlineSize } = await import('./AppListingCardSkeleton');
const { listingGridColumnsAt } = await import('./appListingGrid');
const { LISTING_ACTION_ROW_CONTROL_PX, LISTING_ACTION_ROW_GAP_PX } = await import(
  './appListingCardGeometry'
);

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
async function renderStore(
  gridWidth: number,
  opts: {
    loading: boolean;
    items?: ListingCard[];
    /** Signed-out unless given. An owner gets the `⋮` trigger on every card. */
    viewer?: { id: number; username: string } | null;
  }
) {
  await cleanup();
  mocks.isLoading = opts.loading;
  mocks.items = opts.items ?? [];
  mocks.currentUser = opts.viewer ?? null;
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

/** How many cells share the FIRST visual row — i.e. the column count CSS produced. */
function firstRowCount(cells: HTMLElement[]): number {
  if (cells.length === 0) return 0;
  const tops = cells.map((c) => Math.round(c.getBoundingClientRect().top));
  const first = Math.min(...tops);
  return tops.filter((t) => t === first).length;
}

/** 2dp, so sub-pixel layout is visible but float noise is not. */
const q = (n: number) => Math.round(n * 100) / 100;

/**
 * The rendered width of each card's CTA button — the action row's first child.
 *
 * Resolved structurally because `AppListingCard` puts no testid on the CTA, and
 * VALIDATED rather than trusted: a silently mis-resolved element would make the
 * comparison below compare the wrong boxes and pass.
 *
 * 🔴 THE WALK NO LONGER ENDS AT THE STACK'S **LAST** CHILD, AND THAT IS A REAL
 * BREAK THIS CHANGE CAUSED RATHER THAN A REFACTOR. It used to be
 * `card.lastElementChild` → `stack.lastElementChild` → `firstElementChild`, on the
 * premise that the action row is the last thing in the card's `Stack`. The stats
 * line (recommend rollup + play count) now renders AFTER that row, so
 * `lastElementChild` resolves to the stats line, its first child is the rollup
 * `Group`, and the `BUTTON`/`A` check would throw on every call — loudly, which is
 * the one mercy of having built the check.
 *
 * The row is located by `mt="auto"` instead: it is the only bottom-pinned element
 * on the card, and it is the SAME discriminator `AppListingCard.browser.test.tsx`'s
 * `actionRow()` and `__tests__/appListingCardView.test.ts`'s prop-ledger test use.
 * A positional index would have to move again on the next insertion; this does not.
 */
function ctaWidths(): number[] {
  const cells = Array.from(
    document.querySelectorAll('[data-testid="apps-listing-grid-col"]')
  ) as HTMLElement[];
  return cells.map((cell) => {
    const card = cell.firstElementChild as HTMLElement | null;
    const stack = card?.lastElementChild as HTMLElement | null;
    const actionRow = Array.from(stack?.children ?? []).find(
      (el) => (el as HTMLElement).style.marginTop === 'auto'
    ) as HTMLElement | undefined;
    if (!actionRow) {
      throw new Error(
        `no bottom-pinned (mt="auto") action row among the card stack's children: ` +
          `${stack?.outerHTML.slice(0, 200) ?? 'null'}`
      );
    }
    const cta = actionRow.firstElementChild as HTMLElement | null;
    if (!cta || !(cta.tagName === 'BUTTON' || cta.tagName === 'A')) {
      throw new Error(
        `the walk did not land on the CTA control: ${cta?.outerHTML.slice(0, 200) ?? 'null'}`
      );
    }
    return Math.round(cta.getBoundingClientRect().width * 100) / 100;
  });
}

/**
 * 🔴 REACT'S OWN DOM-VALIDITY CHANNEL, WIRED TO THE RUN'S VERDICT.
 *
 * `validateDOMNesting` is a `console.error`, not a thrown error, so it scrolls past in
 * a run that reports green. That is not hypothetical here: this very file emitted
 * `<div> cannot appear as a descendant of <p>` at `MetaLineSkeleton` on EVERY run of
 * round 1 and still reported 7 passed — the offending element is `position: absolute`,
 * so no box comparison can see it. A geometry suite is structurally blind to invalid
 * nesting; this makes it not blind.
 *
 * Kept as a SECOND, independent signal beside
 * `AppListingCardSkeleton.ssr.browser.test.tsx`'s string scan of the server markup:
 * the two fail differently, so a change to React's warning text cannot disarm both.
 *
 * ⚠️ IT IS ONE CHECK, NOT TEN — AND AN EARLIER VERSION OF THIS NOTE SAID OTHERWISE.
 * It claimed the hook "covers EVERY test in this file rather than the one someone
 * remembered to add it to". React DEDUPES `validateDOMNesting` per warn-key per module
 * instance, so with the defect reintroduced the whole file reports **1 failed / 9
 * passed** even though 9 of the 10 tests render the offending markup; run the late
 * "NO CREATOR" test alone and it reds by itself. The hook does RUN on every test, and
 * the guard is not inert — it goes red — but what it buys is "this file will fail if
 * the pairing is ever rendered", not ten independent assertions. Do not price it as
 * per-test coverage.
 */
const domNestingErrors: string[] = [];
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  mocks.items = [];
  mocks.isLoading = false;
  mocks.currentUser = null;
  domNestingErrors.length = 0;
  // 🔴 CALL THROUGH. `mockImplementation` REPLACES the console method, so a spy that
  // only collects would silently swallow every unrelated React/Mantine warning in this
  // file — in the file whose own docstring says such a warning "scrolls past in a run
  // that reports green". Collect AND forward.
  const originalError = console.error.bind(console) as (...args: unknown[]) => void;
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = args.map((a) => String(a)).join(' ');
    if (text.includes('validateDOMNesting') || text.includes('cannot appear as a descendant')) {
      domNestingErrors.push(text);
    }
    originalError(...args);
  });
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = null;
  // 🔴 ASSERTED IN THE HOOK so no test can forget it — but it is ONE check for the
  // file, not one per test: React dedupes `validateDOMNesting` per warn-key, so with
  // the defect present the file reports 1 failed / 9 passed even though 9 of the 10
  // tests render the offending markup. See the declaration above for the measurement.
  // (An earlier version of this comment claimed it "covers EVERY test in this file",
  // and the correction was ADDED beside the declaration while this sentence — the one
  // a reader debugging a failure actually meets — was left saying the opposite.)
  expect(
    domNestingErrors,
    'React reported invalid DOM nesting while rendering. A parser auto-closes the ' +
      "offending parent, so the parsed DOM and React's tree disagree — that is a " +
      'hydration mismatch on /apps, not a lint nit.'
  ).toEqual([]);
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
   * The cell count is two rows of the grid AS CSS ACTUALLY LAID IT OUT — not two rows
   * of what the ladder says CSS should have done. The count is computed in JS while
   * the tracks come from an `@container` query, so comparing the count against the
   * RENDERED first row is a relationship between the two mechanisms rather than a
   * re-derivation of one from the other.
   *
   * ⚠️ THIS IS **NOT** THE BOX-MODEL DESYNC GUARD, AND AN EARLIER VERSION OF THIS
   * DOCBLOCK CLAIMED IT WAS ("it catches the desync above and any other cause"). An
   * audit measured it PASSING with `padding: 8px` on `.gridContainer` and the
   * component's subtraction removed — i.e. firing identically on its own control,
   * which attributes nothing. The cause is structural, not a bad assertion: both
   * fixtures sit deliberately MID-BAND (1376 is 208px above the 1168 rung, 2450 is
   * 86px above 2364) so an off-by-one cannot reach them, and that same margin means no
   * plausible padding can move the column count either. The property that makes them
   * good PARITY fixtures is what blinds them here. It IS reachable — at `padding: 50px`
   * it reds with its own message — but only at a padding nobody would write.
   *
   * The desync is therefore guarded separately and without any fixture, against the
   * container's own content box: see "the query inline size IS the container's content
   * box" below. What THIS test still buys is the count↔track relationship at two real
   * column counts, which is worth having and is all it should be read as.
   */
  test.each(WIDTHS)(
    'at $gridWidth px the cell count is exactly two rows of the grid CSS actually laid out',
    async ({ gridWidth, columns }) => {
      const m = await renderStore(gridWidth, { loading: true });
      const rendered = firstRowCount(m.cells);
      expect(
        m.cells.length,
        `the grid rendered ${rendered} columns but the skeleton emitted ${m.cells.length} ` +
          `cells, which is not ${APP_LISTING_SKELETON_ROWS} rows of it — so the cell ` +
          'count and the rendered track count disagree. Look at ' +
          '`APP_LISTING_SKELETON_ROWS` and at what the layout effect sets `columns` to. ' +
          '🔴 NOT a box-model lead: this test is measurably blind to that (see its ' +
          'docblock), and "the query inline size IS the container\'s content box" is the ' +
          'guard that owns it — if THAT one is green, padding is not your cause.'
      ).toBe(rendered * APP_LISTING_SKELETON_ROWS);
      // …and the rendered count really is the one the ladder predicts, so a failure
      // above is attributable rather than merely a mismatch between two unknowns.
      expect(rendered).toBe(columns);
    }
  );

  /**
   * 🔴 THE BOX-MODEL DESYNC, GUARDED WITHOUT A FIXTURE.
   *
   * The component picks its column count from `gridQueryInlineSize(container)`, which
   * must equal what an `@container` query sees: the container's CONTENT box.
   * `getBoundingClientRect()` gives the BORDER box, so dropping the padding/border
   * subtraction desynchronises the cell count from the rendered tracks — silently,
   * because today `.gridContainer` has neither.
   *
   * This asserts that equality DIRECTLY, against a second and independent read of the
   * same quantity (`getComputedStyle().width` is the used content-box width whatever
   * `box-sizing` says), and it applies the padding ITSELF rather than waiting for a
   * fixture width at which the count happens to flip. That is what makes it
   * independent of where `WIDTHS` sit — the failure mode the count↔row test above was
   * measured to have.
   */
  test("🔴 the query inline size IS the container's content box, padded or not", async () => {
    await renderStore(WIDTHS[0].gridWidth, { loading: true });
    const container = document.querySelector(
      '[data-testid="apps-listing-skeleton-grid-container"]'
    ) as HTMLElement;
    const grid = document.querySelector(
      '[data-testid="apps-listing-skeleton-grid"]'
    ) as HTMLElement;
    expect(container, 'the skeleton grid container did not render').not.toBeNull();
    expect(grid, 'the skeleton grid did not render').not.toBeNull();

    /**
     * 🔴 THE REFERENCE READ: THE GRID'S OWN WIDTH.
     *
     * `.grid` is a block-level child with no margin, so its border box fills the
     * container's CONTENT box exactly — a layout-derived, fractional, independent
     * measurement of the very quantity the `@container` query sizes.
     *
     * ⚠️ `getComputedStyle(container).width` WAS THE FIRST CHOICE AND IS WRONG, and
     * only the positive control below caught it: under `box-sizing: border-box` —
     * which Preflight sets on everything — Chrome resolves `width` to the BORDER box.
     * Measured with 8px padding + 2px borders on a 1376px container: computed `width`
     * `1376px`, `clientWidth` 1372, true content box 1356. A reference that tracks the
     * value under test is not a reference.
     */
    const contentBox = () => grid.getBoundingClientRect().width;

    // ── ARM 1: as shipped — no padding, no border. The two agree trivially, which is
    // exactly why this arm cannot be the whole guard. It is not useless either: it is
    // what fires if `.gridContainer` ever GAINS padding in the stylesheet while the
    // component still measures the border box.
    expect(
      Math.abs(gridQueryInlineSize(container) - contentBox()),
      "the container query inline size and the grid's own width disagree with no " +
        'padding or border in play — either `.gridContainer` gained one in the ' +
        'stylesheet, or `gridQueryInlineSize` stopped measuring the content box'
    ).toBeLessThan(0.01);
    expect(container.getBoundingClientRect().width).toBeCloseTo(contentBox(), 1);

    // ── ARM 2: the plausible styling change, applied here rather than hoped for.
    //
    // 🔴 ASYMMETRIC, AND EVERY EDGE DISTINCT. An earlier version used `padding: 8px`
    // with equal 2px borders, which cannot tell left from right: the copy-paste mutant
    // `rect.width - px(cs.paddingLeft) - px(cs.paddingLeft)` survived it at 11/11. In
    // production that mis-subtracts by `paddingRight − paddingLeft` on any asymmetric
    // padding, and `padding: 8px 16px` is at least as plausible as `padding: 8px`.
    // Four distinct paddings and two distinct borders make every term observable.
    container.style.padding = '4px 16px 12px 32px'; // T R B L
    container.style.borderLeft = '2px solid transparent';
    container.style.borderRight = '6px solid transparent';
    await nextLayout();

    /** left + right padding + left + right border — what the subtraction must remove. */
    const INLINE_INSETS = 32 + 16 + 2 + 6;

    // POSITIVE CONTROL — the box model really moved, so a pass below is about the
    // subtraction and not about a style that silently did nothing.
    expect(
      container.getBoundingClientRect().width - contentBox(),
      'the padding/border did not change the box model — this arm is testing nothing'
    ).toBeCloseTo(INLINE_INSETS, 1);

    expect(
      Math.abs(gridQueryInlineSize(container) - contentBox()),
      'the measured inline size is the BORDER box, not the CONTENT box. An @container ' +
        'query reads the content box, so the skeleton computes its cell count from a ' +
        'different width than CSS uses for its tracks — restore the padding/border ' +
        'subtraction in `gridQueryInlineSize`.'
    ).toBeLessThan(0.01);

    container.style.padding = '';
    container.style.borderLeft = '';
    container.style.borderRight = '';
  });

  /**
   * 🔴 THE FOURTH CONTENT-VARIANCE AXIS — THE ONLY ONE THAT RAN **DOWNWARD** — IS
   * GONE, AND THIS TEST PINS THE ABSENCE RATHER THAN BEING DELETED WITH IT.
   *
   * ⚠️ RETARGETED, AND THE OLD CLAIM IS RECORDED SO THE CHANGE IS LEGIBLE. This test
   * used to be "a card with NO CREATOR is SHORTER than its skeleton, by exactly the
   * reserved line": `ListingCard.creator` is nullable, `AppListingCard`'s
   * `CreatorChip` returned `null` for a listing without one, and this skeleton
   * reserved that line unconditionally — so such a card was shorter by the creator
   * line plus the meta stack's gap (measured −22.29px at 1376/4, −22.30px at 2450/5).
   *
   * The store card renders NO author chip at all now (2026-09-06, operator's call)
   * and the skeleton reserves no creator line, so the two arms are the SAME height
   * and the downward axis has no subject. Asserting the old delta would be a test
   * that can only fail; deleting it silently would drop the only guard that would
   * notice the chip coming back. So it asserts EQUALITY — with the same two arms,
   * the same fixtures and the same non-vacuity control — and it is mutation-visible
   * in exactly the direction that matters: restore `CreatorChip` to the card and arm
   * B (creator: null) goes short of arm A again.
   *
   * 🔴 THE `keepPreviousData` FIXTURE THAT MOTIVATED THE ORIGINAL IS STILL
   * `creator: null`, which is now simply fine rather than a documented shortfall.
   */
  test('🔴 a card with NO CREATOR is EXACTLY its skeleton — the downward variance axis is gone', async () => {
    const GRID_WIDTH = 1376;

    const skel = await renderStore(GRID_WIDTH, { loading: true });
    const skeletonHeight = skel.boxes[0].height;

    // 🔴 NON-VACUITY ON THE SKELETON ITSELF, FIRST. The retired creator line's
    // testid must be GONE — if it still rendered, both arms would be equally
    // over-reserved and the equality below would hold for the wrong reason.
    expect(
      document.querySelectorAll('[data-testid="apps-listing-skeleton-creator"]'),
      'the skeleton still reserves a creator line, but the card renders no author chip — ' +
        'every card in the store is then SHORTER than its skeleton by that whole line'
    ).toHaveLength(0);
    // …and the line it DOES still reserve is there, so the count above is a real read
    // and not a query against a tree that never rendered.
    expect(
      document.querySelectorAll('[data-testid="apps-listing-skeleton-rollup"]').length,
      'the skeleton reserved no stats line at all — the absence above is vacuous'
    ).toBe(skel.cells.length);

    // Arm A — WITH a creator. This is the parity fixture, and the parity test above
    // already pins it equal to the skeleton; re-read here so the comparison below is
    // between two numbers this test measured itself.
    const withCreator = await renderStore(GRID_WIDTH, {
      loading: false,
      items: POOL.slice(0, skel.cells.length),
    });
    expect(withCreator.boxes[0].height).toBe(skeletonHeight);

    // Arm B — the SAME listings with the creator removed. Nothing else differs.
    const withoutCreator = await renderStore(GRID_WIDTH, {
      loading: false,
      items: POOL.slice(0, skel.cells.length).map((c) => ({ ...c, creator: null })),
    });

    // NON-VACUITY: no profile link on EITHER arm — arm A because the card no longer
    // renders one at all, arm B because its fixture has no creator to render. The
    // first of those is the claim; the second is what the original test checked.
    expect(
      document.querySelectorAll('[data-testid="apps-listing-grid-col"] a[href^="/user/"]'),
      'a creator profile link rendered on the store card — the author chip is back'
    ).toHaveLength(0);
    // …and the cards really did render, so that zero is about the chip.
    expect(withoutCreator.cells.length).toBe(skel.cells.length);

    const delta = q(withCreator.boxes[0].height - withoutCreator.boxes[0].height);
    expect(
      delta,
      `a creator-less card is ${delta}px off a card with a creator. The store card renders ` +
        'no author chip, so `creator` must not move its box at all — a non-zero delta here ' +
        'means a byline came back, and the skeleton (which reserves nothing for one) is ' +
        'then wrong for every listing that has a creator.'
    ).toBe(0);
    // …and both are EXACTLY the skeleton, stated as its own assertion because
    // "the two arms agree" is also true of two arms that are equally wrong.
    expect(withoutCreator.boxes[0].height).toBe(skeletonHeight);
  });

  /**
   * 🔴 THE PLAY COUNT'S OMISSION COSTS NO HEIGHT — MEASURED, BECAUSE THE SKELETON'S
   * LICENCE TO IGNORE THE LISTING'S KIND RESTS ON IT.
   *
   * The card's stats line renders the recommend rollup always and the play count only
   * when `openCount != null`. `null` means the number is structurally unmeasurable —
   * an off-site listing's CTA is a third-party `target="_blank"` anchor, so nothing
   * on-platform observes the click — and the operator's call (2026-09-06) is to omit
   * the stat entirely rather than print a `0` about an app we cannot measure.
   *
   * A loading state cannot know whether the card it is reserving for is on-site or
   * off-site, so the skeleton reserves ONE stats line for both. That is only correct
   * while the omission changes WIDTH and not HEIGHT — i.e. while the two halves share
   * a `wrap="nowrap"` flex line. This measures exactly that, at a real grid width,
   * rather than trusting the `nowrap`.
   *
   * 🔴 THE FIXTURE IS A GENUINE OFF-SITE LISTING, not an on-site one with `openCount`
   * nulled: `cardOpenCount` discriminates on `kind`, so an on-site card can never
   * produce `null` in production and a fixture that forced it would be testing a
   * state the DTO cannot emit. Off-site also changes the CTA (an external `Visit`
   * anchor), which is part of what makes this a worthwhile second shape.
   */
  test('🔴 an OFF-SITE card (no play count) is EXACTLY its skeleton too', async () => {
    const GRID_WIDTH = 1376;

    const skel = await renderStore(GRID_WIDTH, { loading: true });
    const skeletonHeight = skel.boxes[0].height;

    const onsite = await renderStore(GRID_WIDTH, {
      loading: false,
      items: POOL.slice(0, skel.cells.length),
    });
    // 🔴 READ NOW, NOT LATER. `renderStore` cleans the document before each render,
    // so a count taken after the off-site arm would be a count of the off-site tree.
    // This is the POSITIVE half of the control: the selector CAN match.
    const onsitePlayCounts = document.querySelectorAll(
      '[data-testid="apps-listing-play-count"]'
    ).length;

    const offsite = await renderStore(GRID_WIDTH, {
      loading: false,
      items: POOL.slice(0, skel.cells.length).map(
        (c): ListingCard => ({
          ...c,
          kind: 'offsite',
          openCount: null,
          kindData: { kind: 'offsite', externalUrl: `https://${c.slug}.example` },
        })
      ),
    });

    // 🔴 NON-VACUITY, BOTH DIRECTIONS, before any height is compared. The play count
    // must be PRESENT on the on-site arm (read above, while that tree existed) and
    // ABSENT here — otherwise "the heights agree" is a fact about two identical
    // renders, and a `0` from a selector that matches nothing anywhere would look
    // exactly like the behaviour under test.
    expect(
      onsitePlayCounts,
      'the ON-SITE arm rendered no play count, so the absence on the off-site arm is a ' +
        'fact about the selector rather than about `openCount === null`'
    ).toBe(onsite.cells.length);
    expect(
      document.querySelectorAll('[data-testid="apps-listing-play-count"]'),
      'an off-site card rendered a play count — `openCount === null` must omit the stat'
    ).toHaveLength(0);
    // The rollup half DID render, so the zero above is about the play count and not
    // about a stats line that failed to render at all.
    expect(
      document.querySelectorAll('[data-testid="apps-listing-recommend-rollup"]').length,
      'the off-site cards rendered no stats line at all — the absence above is vacuous'
    ).toBe(offsite.cells.length);

    expect(
      offsite.boxes[0].height,
      'an off-site card is not the height its skeleton reserves. The play count is ' +
        'supposed to share the rollup\'s `wrap="nowrap"` flex line, so omitting it costs ' +
        'WIDTH and nothing else — if that is no longer true, the skeleton cannot reserve ' +
        'one box for both kinds and it would have to know a kind it cannot know.'
    ).toBe(skeletonHeight);
    // …and the on-site arm, which DOES render the play count, is the same height.
    expect(onsite.boxes[0].height).toBe(skeletonHeight);
    expect(offsite.boxes).toEqual(onsite.boxes);
  });

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
   * 🔴 THE `LISTING_ACTION_ROW_GAP_PX` EXCLUSION, MEASURED RATHER THAN ASSERTED IN
   * PROSE.
   *
   * `AppListingCardSkeleton` deliberately does not read that constant: it is the gap
   * between the CTA and the `⋮` overflow trigger, a card renders that trigger only
   * for an owner or a moderator, and a loading state cannot know which viewer it is
   * about to serve. `__tests__/appListingCardSkeleton.test.ts` carries the exclusion
   * as a named carve-out, and a carve-out justified by "it costs no geometry" has to
   * have that COST measured, or it is a promise.
   *
   * So: the same listings, the same width, rendered for a signed-out viewer and for
   * their OWNER. The trigger appears, the CTA gives up exactly
   * `LISTING_ACTION_ROW_CONTROL_PX + LISTING_ACTION_ROW_GAP_PX` of width to it — and
   * the CARD's box does not move. That is the whole claim.
   *
   * The fixture carries an icon and a cover here, unlike the parity fixture above:
   * an owner looking at a listing missing either gets the "Incomplete" badge, which
   * would make the owner arm genuinely taller for a reason that has nothing to do
   * with the trigger and would turn this measurement into a different test.
   */
  test('🔴 the ⋮ trigger takes width from the CTA and NOTHING from the card box', async () => {
    const OWNER = { id: 7331, username: 'ashling' };
    const COMPLETE = POOL.slice(0, 8).map((c) => ({
      ...c,
      iconUrl: LOADABLE_IMAGE_DATA_URI,
      coverUrl: LOADABLE_IMAGE_DATA_URI,
    }));
    const GRID_WIDTH = 1376;

    const anon = await renderStore(GRID_WIDTH, { loading: false, items: COMPLETE });
    const anonMenus = document.querySelectorAll(
      '[data-testid="apps-listing-card-actions-menu"]'
    ).length;
    const anonCtas = ctaWidths();

    const owner = await renderStore(GRID_WIDTH, {
      loading: false,
      items: COMPLETE,
      viewer: OWNER,
    });
    const ownerMenus = document.querySelectorAll(
      '[data-testid="apps-listing-card-actions-menu"]'
    ).length;
    const ownerCtas = ctaWidths();

    // POSITIVE CONTROL, FIRST — the two arms must genuinely differ, or "the boxes
    // are equal" is a fact about rendering the same thing twice.
    expect(anonMenus, 'the signed-out arm rendered a ⋮ trigger it should not have').toBe(0);
    expect(ownerMenus, 'the owner arm rendered no ⋮ trigger — the arms are identical').toBe(
      owner.cells.length
    );
    // …and no "Incomplete" badge crept in, which would make the owner arm taller for
    // an unrelated reason.
    expect(document.querySelectorAll('[data-testid="apps-listing-owner-incomplete"]')).toHaveLength(
      0
    );

    // THE CTA PAYS FOR THE TRIGGER — exactly the trigger plus the row gap.
    expect(anonCtas.length).toBe(ownerCtas.length);
    for (let i = 0; i < anonCtas.length; i++) {
      expect(
        Math.round(anonCtas[i] - ownerCtas[i]),
        `CTA ${i} did not give up exactly the trigger + gap when the ⋮ appeared ` +
          `(${anonCtas[i]} -> ${ownerCtas[i]})`
      ).toBe(LISTING_ACTION_ROW_CONTROL_PX + LISTING_ACTION_ROW_GAP_PX);
    }

    // …AND THE CARD DOES NOT MOVE. This is what licenses the skeleton to ignore the
    // gap constant.
    expect(
      anon.boxes,
      'a card changes box when its viewer gains the ⋮ trigger — the skeleton cannot ' +
        'then reserve one box for both viewers, and the gap exclusion in ' +
        '__tests__/appListingCardSkeleton.test.ts is wrong'
    ).toEqual(owner.boxes);
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
