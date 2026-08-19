/**
 * App-listing detail — the SCREENSHOT GALLERY's RENDERED WIDTH.
 *
 * The reported defect: a listing with ONE screenshot rendered it at roughly half the
 * main column with dead space beside it (observed live at 1440px: ~415px of image in
 * an ~880px column), and the trailing tile of any ODD count did the same. The gallery
 * was a fixed two-track `SimpleGrid`, so an unpaired tile occupied one track and left
 * the other empty. The fix is one CSS rule — `.gallery > :last-child:nth-child(odd) {
 * grid-column: 1 / -1 }` — and this file is the only place that can prove it, because
 * it is the only place a real layout engine runs.
 *
 * 🔴 READ THIS BEFORE TRUSTING IT AS A GATE: IT IS NOT ONE. This file is in the
 * Vitest browser-mode `component` project, which CI runs only as the preview
 * pipeline's `preview / component-tests` — report-only, non-blocking, and not
 * reported at all when the preview build fails. The enforceable half of the change is
 * the seam gate in the blocking node project (`__tests__/appListingGalleryFill.test.ts`),
 * which pins that the rule and the `className` both exist and agree. That gate cannot
 * see a single pixel; this file cannot block a merge. Both claims are needed and
 * neither substitutes for the other.
 *
 * 🔴 WHY THIS FILE LOADS `@mantine/core/styles.css` AND ITS SIBLING MUST NOT.
 * `AppListingDetailBody.browser.test.tsx` deliberately loads no stylesheet and says so
 * in its header — every assertion there is structural (DOM order, props, ARIA). But
 * every number here comes FROM a stylesheet: `SimpleGrid`'s
 * `grid-template-columns: repeat(var(--sg-cols), minmax(0, 1fr))` is a Mantine rule,
 * and without it the grid container is a plain block, every tile is full width by
 * default, and the "a lone tile fills the row" assertions below would pass while
 * measuring nothing at all. That is not a hypothetical — it is the single most likely
 * way this file goes vacuously green, which is why the TWO-screenshot case is asserted
 * first and treated as the instrument control (see it). Vitest browser mode runs each
 * test file in its own iframe, so this import does not leak into the sibling suites.
 *
 * 🔴 WHAT IS ASSERTED IS GEOMETRY, NOT A CLASS NAME. A test that pinned
 * `className`, `cols`, or the presence of a CSS rule passes with the rendered width
 * still wrong — that check already exists in the node project and is honest about
 * being source text. Here every assertion is a measured `getBoundingClientRect()`
 * width, stated RELATIVE to the gallery's own container width, so it is a claim about
 * what the viewer sees rather than about what the source says.
 *
 * MEASURED, at 1440x900, `spacing="md"` = a 16px column gap. The main column's content
 * box — the gallery's container — resolves to 949.33px here, so one track is 466.66px.
 * (That container is WIDER than the ~880px seen on the live page, because this file
 * mounts the body directly rather than inside the page's 1320px `Container`. Nothing
 * below is asserted against an absolute px value for exactly that reason: every claim
 * is stated relative to the measured `gridWidth`, so it holds at any container width.)
 *
 * The "before" column is the ISOLATED mutation — `className={galleryClasses.gallery}`
 * removed and NOTHING else, so the stylesheet, the testid and the import all stay put
 * and the only variable is whether the fill rule applies:
 *
 *                              before                after           at base
 *   1 screenshot               466.66               949.33            RED
 *   3 screenshots       466.66 x2 + 466.66   466.66 x2 + 949.33       RED
 *   3, last two 404       466.66 (survivor)        949.33             RED
 *   2 screenshots           466.66 x2            466.66 x2           green  <- control
 *   3, middle 404s          466.66 x2            466.66 x2           green  <- invariant
 *   0 screenshots           no section           no section          green  <- invariant
 *   390x844, 3 shots      full width x3        full width x3         green  <- invariant
 *
 * The four green rows are what make the three red ones mean something: they say the
 * rule fires ONLY on a tile with no partner. A rule that widened everything would take
 * the control and the middle-404 case down with it.
 */
import '@mantine/core/styles.css';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

const WIDE: [number, number] = [1440, 900];
const NARROW: [number, number] = [390, 844];

/** Mantine `spacing="md"` — the gallery's column gap, in px. */
const GAP = 16;

// Anonymous viewer, so the `⋮` menu and its modals never mount. Nothing in this file
// is about them and each one is a portal that would sit outside the measured tree.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock): a hand-written factory silently breaks every importer
// the day the real module grows an export it omits — and in this project that
// surfaces as `Tests no tests`, i.e. as nothing to see rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true, appListings: true, appBlocksPages: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      // The discovery rail sits BELOW the two-column grid, so what it returns cannot
      // move a tile. Empty anyway, to keep the suite network-free.
      listAvailable: { useQuery: () => ({ data: { items: [] }, isLoading: false }) },
      getMyReview: { useQuery: () => ({ data: null, isLoading: false }) },
      upsertReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      reportListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    user: {
      getCreator: { useQuery: () => ({ data: null }) },
      getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: async () => undefined },
        listReviews: { invalidate: async () => undefined },
        getAppDetail: { invalidate: async () => undefined },
      },
    }),
  },
}));
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppListingDetailBody } = await import('./AppListingDetailBody');

beforeEach(async () => {
  // 🔴 Restore the WIDE viewport before every test. The viewport is browser-global
  // state, so without this the one narrow test below would silently re-run every
  // later test at 390px and the two-track assertions would measure a one-track grid.
  await page.viewport(...WIDE);
});

/**
 * A screenshot URL that RESOLVES — an inline 320x180 SVG. It has to be a real,
 * loadable image: `ScreenshotTile` removes itself from the DOM on an `error` event, so
 * a tile built from an unreachable URL is not a tile whose width can be measured. The
 * 16:9 box keeps the rendered rows a sane height; only widths are asserted.
 */
const OK_SHOT = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>'
)}`;

/** A URL that cannot resolve, so the browser fires `error` and the tile hides itself. */
const BROKEN_SHOT = (n: number) => `https://cdn.invalid.example/missing-${n}.png`;

function base(over: Partial<ListingDetail>): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
    name: 'My App',
    tagline: 'A handy app',
    description: null,
    category: 'utility',
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    // 🔴 `null` DELIBERATELY. A creator mounts `SmartCreatorCard`, a live tRPC surface
    // with its own child graph — none of which this file is about, and all of which
    // would need mocking to keep the render clean. It sits in the RAIL, whose width is
    // set by the grid's column span and not by its contents, so the gallery's
    // container width is identical either way.
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    installCount: 4213,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
    ...over,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

type Geometry = {
  /** Guard-the-guard — false means Mantine's stylesheet did not load. */
  gridIsGrid: boolean;
  trackCount: number;
  columnGap: number;
  gridWidth: number;
  /**
   * The main column's CONTENT width — its border box minus its own inline padding.
   *
   * 🔴 Not `getBoundingClientRect().width`. `ContainerGrid2`'s columns carry the
   * grid gutter as inline PADDING (16px a side here), so the border box is 32px wider
   * than anything that can ever be laid out inside it. Comparing the gallery against
   * that number reports a 32px shortfall on a gallery that is in fact flush with its
   * column — a permanent false red that would get this assertion deleted.
   */
  mainColContentWidth: number;
  tiles: { width: number; left: number; top: number }[];
};

function measure(container: HTMLElement): Geometry {
  const grid = container.querySelector(
    '[data-testid="apps-listing-screenshot-grid"]'
  ) as HTMLElement;
  const main = container.querySelector('[data-testid="apps-listing-main-col"]') as HTMLElement;
  const cs = getComputedStyle(grid);
  const mainCs = getComputedStyle(main);
  return {
    gridIsGrid: cs.display === 'grid',
    // A resolved `grid-template-columns` is a space-separated list of used track
    // sizes, so its length IS the track count. `none` (no grid) splits to 1, which is
    // why `gridIsGrid` is asserted alongside it rather than instead of it.
    trackCount: cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length,
    columnGap: round(parseFloat(cs.columnGap)),
    gridWidth: round(grid.getBoundingClientRect().width),
    mainColContentWidth: round(
      main.getBoundingClientRect().width -
        parseFloat(mainCs.paddingLeft) -
        parseFloat(mainCs.paddingRight)
    ),
    tiles: Array.from(grid.children).map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { width: round(r.width), left: round(r.left), top: round(r.top) };
    }),
  };
}

async function renderGallery(detail: ListingDetail) {
  const { container } = await renderWithProviders(<AppListingDetailBody detail={detail} />);
  const within = page.elementLocator(container);
  await expect.element(within.getByText('My App')).toBeInTheDocument();
  // Two frames so layout + the injected stylesheet have both settled.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  return { container, within };
}

/**
 * Assert the grid really is a two-track CSS grid at this viewport. Every width claim
 * below is meaningless without it: with no stylesheet the container is a block, tiles
 * are full width by default, and "the lone tile fills the row" passes for the wrong
 * reason.
 */
function expectTwoTrackGrid(g: Geometry) {
  expect(g.gridIsGrid).toBe(true);
  expect(g.trackCount).toBe(2);
  expect(g.columnGap).toBe(GAP);
  // A floor, so a collapsed or zero-width column cannot produce a vacuous pass on
  // any of the equalities below.
  expect(g.gridWidth).toBeGreaterThan(400);
  // The gallery fills the main column it sits in — the column whose unused half is
  // the whole complaint.
  expect(g.gridWidth).toBeCloseTo(g.mainColContentWidth, 1);
}

/** The width one track of a two-track grid resolves to — i.e. the DEFECT's width. */
const halfTrack = (g: Geometry) => round((g.gridWidth - GAP) / 2);

/**
 * Compare two measured px values with a 0.05px tolerance.
 *
 * 🔴 Sub-pixel, and bounded on purpose. Chromium lays a 949.33px grid out as two
 * 466.66px tracks while `(949.33 - 16) / 2` rounds to 466.67 — a 0.01px disagreement
 * that made three tests red for a reason that had nothing to do with the layout. The
 * tolerance absorbs that and NOTHING else: every difference this file exists to detect
 * is a factor of two (466 vs 949), four orders of magnitude away from it. Do not widen
 * it — a tolerance large enough to hide a real regression is how a geometry suite
 * becomes decorative.
 */
const expectWidth = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 1);

describe('screenshot gallery — rendered tile width', () => {
  /**
   * 🔴 THE INSTRUMENT CONTROL, AND IT IS DELIBERATELY FIRST.
   *
   * This case is UNCHANGED by the fix — green before and after — so it is an invariant
   * guard, not regression coverage, and must not be counted as any. Its job is to make
   * every other assertion in this file mean something: it proves the measurement can
   * tell HALF from FULL. If Mantine's stylesheet failed to load, or `SimpleGrid` stopped
   * being a grid, or the fill rule leaked onto tiles that DO have a partner, the tiles
   * here would measure full width and this test would go red — which is exactly what
   * stops the one- and three-screenshot cases below from passing for the wrong reason.
   */
  test('2 screenshots — CONTROL: a paired row stays two half-width tiles', async () => {
    const { container } = await renderGallery(
      base({
        screenshots: [
          { url: OK_SHOT, caption: null },
          { url: OK_SHOT, caption: null },
        ],
      })
    );
    const g = measure(container);
    expectTwoTrackGrid(g);

    expect(g.tiles).toHaveLength(2);
    expectWidth(g.tiles[0].width, halfTrack(g));
    expectWidth(g.tiles[1].width, halfTrack(g));
    // …and they are genuinely SIDE BY SIDE, not two full-width tiles that happen to
    // measure the same. Same row, second one a gap to the right of the first.
    expect(g.tiles[1].top).toBe(g.tiles[0].top);
    expectWidth(g.tiles[1].left, round(g.tiles[0].left + g.tiles[0].width + GAP));
    // The number that names the defect: half a track is nowhere near the column.
    expect(g.tiles[0].width).toBeLessThan(g.gridWidth * 0.55);
  });

  /**
   * 🔴 THE REPORTED DEFECT. RED AT BASE: the single tile measured one track —
   * 421.33px inside an 858.66px column — leaving 437.33px of dead space beside it.
   */
  test('1 screenshot — the lone tile fills the whole column', async () => {
    const { container } = await renderGallery(
      base({ screenshots: [{ url: OK_SHOT, caption: null }] })
    );
    const g = measure(container);
    expectTwoTrackGrid(g);

    expect(g.tiles).toHaveLength(1);
    expectWidth(g.tiles[0].width, g.gridWidth);
    // Stated a second way, against the DEFECT's own number rather than against the
    // container: the tile is not one track wide. `halfTrack` is derived from the same
    // measured `gridWidth`, so this cannot drift with the viewport or the container.
    expect(g.tiles[0].width).toBeGreaterThan(halfTrack(g) * 1.9);
  });

  /**
   * 🔴 THE SAME BUG IN ITS SECOND SHAPE. RED AT BASE: the third tile measured one
   * track and left the rest of its row empty.
   */
  test('3 screenshots — the first two pair up, the odd trailing tile fills its row', async () => {
    const { container } = await renderGallery(
      base({
        screenshots: [
          { url: OK_SHOT, caption: null },
          { url: OK_SHOT, caption: null },
          { url: OK_SHOT, caption: null },
        ],
      })
    );
    const g = measure(container);
    expectTwoTrackGrid(g);

    expect(g.tiles).toHaveLength(3);
    // Row 1 is untouched — the fix must not widen a tile that HAS a partner.
    expectWidth(g.tiles[0].width, halfTrack(g));
    expectWidth(g.tiles[1].width, halfTrack(g));
    expect(g.tiles[1].top).toBe(g.tiles[0].top);
    // Row 2 is the whole column, flush with the grid's left edge.
    expectWidth(g.tiles[2].width, g.gridWidth);
    expectWidth(g.tiles[2].left, g.tiles[0].left);
    expect(g.tiles[2].top).toBeGreaterThan(g.tiles[0].top);
  });

  /**
   * 🔴 THE COUNT-MISMATCH CASE — the reason the fix is a CSS structural selector and
   * not a `cols` value computed from `screenshots.length`.
   *
   * Three screenshots go in; two of them 404, so `ScreenshotTile` removes them and the
   * browser ends up with ONE tile. Any number derived before render would still say
   * "3" here and would leave that survivor at half width. `:last-child:nth-child(odd)`
   * is matched against the LIVE DOM, so the remaining tile is re-matched for free.
   *
   * RED AT BASE: the survivor measured one track.
   */
  test('3 screenshots, two of them 404 — the surviving tile fills the column', async () => {
    // 🔴 THE SURVIVOR IS THE MIDDLE ENTRY, DELIBERATELY. Its `alt` is generated from
    // the tile's INDEX IN THE FULL ARRAY, so "screenshot 2" is a string only a
    // three-element map can produce — which is what makes this a real positive
    // control for "three tiles were rendered and two removed themselves", rather than
    // for "the fixture only ever had one".
    //
    // 🔴 An immediate `expect(tiles).toHaveLength(3)` is what this replaces, and it
    // was RACY, not merely redundant: the data-URI tiles resolve instantly while the
    // unreachable host fails DNS in about as long, so the count had already dropped
    // to 2 by the time the render settled. It failed 1-in-1 here; a slightly faster
    // box would have made it flaky instead, which is worse. The `alt` is a fact about
    // the render that no timing can change.
    const { container } = await renderGallery(
      base({
        screenshots: [
          { url: BROKEN_SHOT(1), caption: null },
          { url: OK_SHOT, caption: null },
          { url: BROKEN_SHOT(2), caption: null },
        ],
      })
    );

    const grid = container.querySelector(
      '[data-testid="apps-listing-screenshot-grid"]'
    ) as HTMLElement;
    await vi.waitUntil(() => grid.children.length === 1, { timeout: 10000, interval: 25 });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

    expect(Array.from(grid.querySelectorAll('img')).map((img) => img.getAttribute('alt'))).toEqual([
      'My App screenshot 2',
    ]);

    const g = measure(container);
    expectTwoTrackGrid(g);
    expect(g.tiles).toHaveLength(1);
    expectWidth(g.tiles[0].width, g.gridWidth);
  });

  /**
   * The other direction of the same mismatch, and an INVARIANT GUARD rather than
   * regression coverage — it was green before the fix too. Three go in, ONE 404s, two
   * survive: a fill rule that keyed on anything other than the live DOM would either
   * widen a tile that now has a partner, or leave the pair alone for the wrong reason.
   * This is what says the rule does not over-fire.
   */
  test('3 screenshots, the MIDDLE one 404s — the two survivors pair up (invariant guard)', async () => {
    const { container } = await renderGallery(
      base({
        screenshots: [
          { url: OK_SHOT, caption: null },
          { url: BROKEN_SHOT(3), caption: null },
          { url: OK_SHOT, caption: null },
        ],
      })
    );
    const grid = container.querySelector(
      '[data-testid="apps-listing-screenshot-grid"]'
    ) as HTMLElement;
    await vi.waitUntil(() => grid.children.length === 2, { timeout: 10000, interval: 25 });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

    // POSITIVE CONTROL, and not a racy one — see the sibling test above. Indexes 1 and
    // 3 with nothing between them is a string pair only a three-element map can
    // produce, so the middle tile demonstrably rendered and then removed itself.
    expect(Array.from(grid.querySelectorAll('img')).map((img) => img.getAttribute('alt'))).toEqual([
      'My App screenshot 1',
      'My App screenshot 3',
    ]);

    const g = measure(container);
    expectTwoTrackGrid(g);
    expect(g.tiles).toHaveLength(2);
    expectWidth(g.tiles[0].width, halfTrack(g));
    expectWidth(g.tiles[1].width, halfTrack(g));
    expect(g.tiles[1].top).toBe(g.tiles[0].top);
  });

  /**
   * 🔴 0 screenshots — INVARIANT GUARD, unchanged by this PR. The section is hidden
   * entirely, and it must stay hidden: the brief for this change was explicitly not to
   * invent content for a sparse listing, so a gallery that started rendering an empty
   * full-width box would be a regression introduced BY the fix.
   */
  test('0 screenshots — no gallery section at all (invariant guard)', async () => {
    const { container, within } = await renderGallery(base({ screenshots: [] }));
    expect(container.querySelectorAll('[data-testid="apps-listing-screenshot-grid"]')).toHaveLength(
      0
    );
    expect(within.getByText('Screenshots').elements()).toHaveLength(0);
    // …and the rest of the page is still there, so this is a hidden section rather
    // than a failed render.
    const main = container.querySelector('[data-testid="apps-listing-main-col"]') as HTMLElement;
    expect(main.getBoundingClientRect().width).toBeGreaterThan(400);
  });

  /**
   * 🔴 THE SECOND MEASURED POINT — a phone, where the gallery is ONE track.
   *
   * This is why the rule is `grid-column: 1 / -1` and not `span 2`. Below Mantine's
   * `sm` breakpoint `cols` is 1, and asking for a 2-track span on a 1-track grid makes
   * the browser create an implicit second column — which would render every tile at
   * HALF the phone's width, turning a desktop fix into a mobile defect. `1 / -1` spans
   * "first line to last line", so on one track it is a no-op. One viewport could not
   * have seen this; two can.
   *
   * 🔴 MUTATION-TESTED, not assumed. Rewriting the stylesheet's `grid-column: 1 / -1`
   * as `grid-column: span 2` — the narrowest expression that can be wrong, with the
   * selector and everything else untouched — leaves ALL SIX other tests in this file
   * green and takes ONLY this one red, at `trackCount` (`expected 2 to be 1`: the
   * implicit column really is created). So the hazard is real, this test is the only
   * thing that sees it, and it dies for its own reason rather than to a neighbour's
   * assertion.
   */
  test('390x844 — one track, and the fill rule is a no-op there', async () => {
    await page.viewport(...NARROW);
    const { container } = await renderGallery(
      base({
        screenshots: [
          { url: OK_SHOT, caption: null },
          { url: OK_SHOT, caption: null },
          { url: OK_SHOT, caption: null },
        ],
      })
    );
    const g = measure(container);
    expect(g.gridIsGrid).toBe(true);
    expect(g.trackCount).toBe(1);
    expect(g.tiles).toHaveLength(3);
    // Every tile — the two that pair up on desktop AND the odd trailing one — is the
    // full width of the single track. If `1 / -1` had been written `span 2`, the
    // trailing tile would measure about half of this.
    for (const tile of g.tiles) expectWidth(tile.width, g.gridWidth);
    // …and they really are stacked, not squeezed side by side.
    expect(g.tiles[1].top).toBeGreaterThan(g.tiles[0].top);
    expect(g.tiles[2].top).toBeGreaterThan(g.tiles[1].top);
  });
});
