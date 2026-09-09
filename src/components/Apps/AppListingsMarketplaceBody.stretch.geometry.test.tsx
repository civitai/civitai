/**
 * `/apps` store grid — THE CARD-STRETCH SEAM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING GUARDED, AND WHY IT IS A SEAM RATHER THAN A COMPONENT TEST
 * ─────────────────────────────────────────────────────────────────────────────
 * `AppListingCard` bottom-pins its action row with `mt="auto"`, inside a
 * `<Stack h="100%">`, inside a `<Card className="h-full">`. None of that chain
 * resolves to a real height on its own: `h-full` is `height: 100%`, which needs a
 * parent with a definite height, and what supplies one HERE is the GRID stretching its
 * items to the row's height — i.e. `align-items: normal`, the default for a grid
 * container. It is not the only conceivable source (a definite height on the wrapper
 * would do it too), which is why the guard measures rendered boxes rather than asserting
 * one particular property.
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
 * `h-full` IS A TAILWIND UTILITY, AND WHICH TIER YOU ARE IN DECIDES WHETHER IT
 * RESOLVES — but the accurate statement is narrower than "the `component` tier has
 * no Tailwind", so state it precisely:
 *
 *   · BY DEFAULT it does not. `test/component-setup.tsx` parses `globals.css?raw`
 *     into a throwaway `CSSStyleSheet`, walks it for unconditional `:root` rules and
 *     injects a `<style>` holding ONLY the `--*` custom properties (24 CSS rules — that
 *     count is `test/geometry-setup.tsx`'s, recorded there 2026-09-03, and is NOT
 *     re-measured here; what this file re-measures every run is `cascadeEvidence()`). No utilities, no preflight. Its own docstring records why importing the
 *     real sheet instead was rejected: it moves the rendered geometry of every
 *     existing test in that tier.
 *   · BUT THREE SPECS OPT IN, by importing `~/styles/globals.css` for its side effect
 *     (`AppListingCard.browser.test.tsx`, `ImageCard.browser.test.tsx`,
 *     `ImageResources.browser.test.tsx` — measured at this ref; two more import it as
 *     `?raw` TEXT, which injects nothing). Vite runs those through PostCSS, so
 *     Tailwind utilities genuinely DO resolve there. Anyone claiming a spec in that
 *     tier "cannot see Tailwind" has to check the file, not the tier.
 *
 * 🔴 SO THE REASON THIS GUARD IS HERE IS THE CASCADE **LAYER ORDER**, NOT THE MERE
 * PRESENCE OF TAILWIND. An opted-in `component` spec gets `globals.css` (and possibly
 * `@mantine/core/styles.layer.css`) without `test/cascade-layer-order.css` and without
 * the other Mantine layer sheets. A layer's priority is fixed at its FIRST APPEARANCE
 * in the CSSOM, so with no `@layer tailwind-preflight, theme, mantine, modules;`
 * parsed first, layer priority falls out of import order — a THIRD cascade, matching
 * neither this tier's default nor production. `test/geometry-setup.tsx` parses that
 * declaration first and then loads `globals.css` + the six Mantine
 * `<pkg>/styles.layer.css` sheets + `mantine-react-table/styles.css`, i.e.
 * `src/pages/_document.tsx` followed by
 * `src/pages/_app.tsx`, in that order. This seam is a fight between a Tailwind
 * utility (`h-full`), a Mantine component rule (`Card`) and a CSS Module (`.grid`) —
 * exactly the three layers that declaration orders — so it needs the real one.
 *
 * That this matters is not theory: the first draft of this guard lived in
 * `AppListingsMarketplaceBody.columns.browser.test.tsx`, which imports only
 * `@mantine/core/styles.css` and therefore gets the tier default. It reported heights
 * of `[458.23, 312.75, 434.23, 312.75]` on a CORRECT grid, because `h-full` did
 * nothing there. A test that cannot distinguish the fix from the defect is worse than
 * no test, and it would have been read as this guard working.
 *
 * This file asserts the cascade arrived (`cascadeEvidence()`), so a stylesheet that
 * fails to load fails the run rather than quietly reproducing the defect's numbers.
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

// Same mock set, and the same reasons, as the sibling `.browser.test.tsx` files — see
// the long notes in `AppListingsMarketplaceBody.browser.test.tsx`. In short: the card
// reads `useCurrentUser`, the filters dropdown reads `useIsClient` + `useIsMobile` and
// both THROW without a provider, and the flags factory must name BOTH flag hooks or the
// whole file fails to IMPORT and reports `no tests` rather than a failure.
// `next/router` is already mocked by `test/geometry-setup.tsx`.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false, isMobileDevice: () => false }));
// 🔴 THE TWO BANNERS `MainContent` ALWAYS RENDERS, STUBBED TO NULL. They are not part of
// the width chain — they sit inside the same `<main>` and contribute no horizontal box —
// but `VerifyEmailBanner` reads `trpc.user.resendEmailVerification`, which this file's
// wholesale trpc factory does not carry. Stubbing the two components is a smaller and more
// honest surface than growing that factory with routes the fixture never exercises.
vi.mock('~/components/User/VerifyEmailBanner', () => ({ VerifyEmailBanner: () => null }));
vi.mock('~/components/Buzz/RewardsBonusBanner', () => ({ RewardsBonusBanner: () => null }));
// 🔴 THE FACTORY MUST NAME EVERY EXPORT THE GRAPH IMPORTS — a wholesale mock replaces the
// module outright, so one missing name makes the whole FILE fail to import and reports as
// `Tests no tests` rather than as a failure. `useFeatureFlagsReady` is here because
// rendering the real `MainContent` pulls `AppLayout`'s graph in, which reads it; the exact
// error was `does not provide an export named 'useFeatureFlagsReady'`, and half a dozen
// sibling specs carry the same note.
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
          data: { pages: [{ items: mocks.items, nextCursor: undefined }] },
          isLoading: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          hasNextPage: false,
        }),
      },
    },
    // `AppsPageLayout` -> `AppsSubNav` reads this; the real-chain fixture below renders
    // the layout, so the factory has to carry it or that render throws.
    blocks: { getNavSummary: { useQuery: () => ({ data: undefined }) } },
  },
}));

// Import AFTER the mocks (vi.mock is hoisted; static imports are not).
const { AppListingsMarketplaceBody } = await import('./AppListingsMarketplaceBody');
const { AppsPageLayout } = await import('./AppsPageLayout');
const { MainContent } = await import('~/components/AppLayout/AppLayout');
const { APPS_CONTAINER_GUTTER } = await import('./appsPageWidths');
const { listingGridColumnsAt, MANTINE_BREAKPOINT_PX } = await import('./appListingGrid');

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
 * `data-testid` on its action row and this file does not add one. So the resolver walks my
 * own grid cell → the `Card` → the body `Stack` → the BOTTOM-PINNED child. Each step is
 * then checked against something only the real action row satisfies, and a failed check
 * THROWS with the offending `outerHTML` rather than returning a wrong element — a silently
 * mis-resolved element would make every assertion below compare the wrong boxes and pass.
 *
 * 🔴 "BOTTOM-PINNED", NOT "LAST" — AND THIS RESOLVER REALLY DID BREAK. It used to take
 * `stack.lastElementChild`, and VALIDATION 2 below used to REQUIRE
 * `actionRow.nextElementSibling === null`. `AppListingCard` now renders a stats line
 * (recommend rollup + play count) AFTER the action row, so the last child is that stats
 * line: the walk would resolve to it, VALIDATION 1 would find no link or button inside it,
 * and every test in this file would throw. Loud, which is what the validations are for —
 * but it is a break, not a refactor, and the fix is not to relax the checks.
 *
 * `mt="auto"` is the discriminator instead: it is the only bottom-pinned element on the
 * card, and it is what `AppListingCard.browser.test.tsx`'s `actionRow()`,
 * `AppListingCardSkeleton.geometry.test.tsx`'s `ctaWidths()` and
 * `__tests__/appListingCardView.test.ts`'s prop ledger all key on. A positional index would
 * have to be re-derived on the next insertion; this does not.
 */
function cardPartsOf(cell: HTMLElement) {
  const card = cell.firstElementChild as HTMLElement | null;
  if (!card) throw new Error(`grid cell has no card child: ${cell.outerHTML.slice(0, 200)}`);
  const stack = card.lastElementChild as HTMLElement | null;
  if (!stack) throw new Error(`card has no body stack: ${card.outerHTML.slice(0, 200)}`);
  const pinned = Array.from(stack.children).filter(
    (el) => (el as HTMLElement).style.marginTop === 'auto'
  ) as HTMLElement[];
  // VALIDATION 0 — EXACTLY ONE bottom-pinned child. Two auto top margins in one column
  // flex container SPLIT the free space between them, so "the action row is at the bottom"
  // would silently stop being true while every element still resolved.
  if (pinned.length !== 1) {
    throw new Error(
      `expected exactly ONE mt="auto" child in the card body, found ${pinned.length}: ` +
        stack.outerHTML.slice(0, 300)
    );
  }
  const actionRow = pinned[0];
  // VALIDATION 1 — the action row is the one holding the card's controls. The title block
  // above it holds a link too, so this does not identify it alone; it is what rules out
  // having resolved to a `<Text>` tagline.
  if (actionRow.querySelectorAll('a[href], button').length === 0) {
    throw new Error(
      'resolved "action row" holds no link or button — the walk found the wrong element: ' +
        actionRow.outerHTML.slice(0, 300)
    );
  }
  // VALIDATION 2 — SOMETHING IS ABOVE IT. (This used to demand the action row be the LAST
  // child of the card body; the stats line now follows it, so that check has no subject —
  // see the note above. What replaces it is the property the measurements below actually
  // need.) `contentBottom` is `previousElementSibling`'s bottom and is the NON-VACUITY
  // CONTROL for the whole file; if the row were the first child that control would be
  // `null` on every card and `new Set([null,null,…]).size` would be 1, which the control
  // reports as "the fixtures do not differ" rather than as a broken walk.
  if (actionRow.previousElementSibling === null) {
    throw new Error(
      'resolved "action row" is the card body\'s FIRST child, so there is no content above ' +
        'it to measure: ' +
        stack.outerHTML.slice(0, 300)
    );
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

/**
 * A THIN SCROLLBAR, in px. Chrome/Firefox on Windows and Linux reserve roughly this much
 * inside a `scrollbar-width: thin` box; macOS overlay scrollbars and touch reserve none.
 * Used to drive the production-shaped case deterministically — see the note on the
 * real-chain describe below for why it cannot be measured natively here.
 */
const THIN_SCROLLBAR_PX = 10;

/**
 * Render the REAL production chain — `.scroll-area` -> `AppsPageLayout`'s `Container` ->
 * the store body -> the grid — at an explicit viewport, with content tall enough that the
 * scroll container genuinely overflows.
 *
 * `availableWidth` narrows the scroll box the way a reserved scrollbar does on a platform
 * that has one. Left undefined, the box is the full viewport.
 */
async function renderRealChain(
  viewport: { width: number; height: number },
  availableWidth?: number
) {
  await cleanup();
  await renderAtViewport(
    <div style={{ display: 'flex', flexDirection: 'column', height: viewport.height }}>
      {/* 🔴 THE REAL `MainContent`, NOT A HAND-BUILT COPY OF IT — and that is the point of
          calling this fixture "the real chain". `MainContent` supplies BOTH links this
          measurement depends on: the `ScrollArea` (`.scroll-area`, the scrollbar-consuming
          box) and the `<main className="min-w-0 flex-1">` between it and the page.

          That `<main>` is load-bearing, not padding: `.scroll-area` is `display: flex;
          flex-direction: column`, and Mantine's `Container` carries `margin-inline: auto`,
          which in a flex container's CROSS axis disables stretch — so without a plain block
          in between, the Container shrink-to-fits its content. An earlier draft of this
          fixture hand-wrote that `<main>` and measured 553.02px instead of 1168 when it was
          omitted, which is how its weight was discovered.

          🔴 SO IT IS RENDERED RATHER THAN COPIED. A literal `<main className="min-w-0
          flex-1">` here would be a duplicate of a production value with nothing checking the
          two agree: adding `px-2` to `AppLayout`'s scrollable branch would make production's
          grid `viewport − scrollbar − 16 − 32` while this fixture kept measuring the old
          number and stayed green. Rendering the component makes that mutation fail HERE —
          checked, see the mutation table in the PR body.

          `subNav`/`footer` are nulled because they are vertical chrome that contributes no
          horizontal box; the two banners `MainContent` renders unconditionally are stubbed
          above for the same reason. */}
      <MainContent
        data-testid="scroll-area"
        subNav={null}
        footer={null}
        style={availableWidth != null ? { width: availableWidth } : undefined}
      >
        <AppsPageLayout>
          <AppListingsMarketplaceBody />
        </AppsPageLayout>
        {/* Force the overflow that makes a scrollbar appear at all. */}
        <div style={{ height: viewport.height * 4 }} />
      </MainContent>
    </div>,
    viewport
  );
  await nextLayout();
  const scrollArea = document.querySelector('[data-testid="scroll-area"]') as HTMLElement | null;
  const grid = document.querySelector('[data-testid="apps-listing-grid"]') as HTMLElement | null;
  const cells = Array.from(
    document.querySelectorAll('[data-testid="apps-listing-grid-col"]')
  ) as HTMLElement[];
  if (!scrollArea || !grid) {
    throw new Error(`real chain not rendered (scrollArea=${!!scrollArea} grid=${!!grid})`);
  }
  return {
    scrollArea,
    grid,
    /** What the scroll box actually offers its content — the number the ladder reads. */
    availableInBox: scrollArea.clientWidth,
    /** How much the harness's scrollbar takes. 0 when scrollbars are hidden. */
    reserve: scrollArea.offsetWidth - scrollArea.clientWidth,
    gridWidth: q(grid.getBoundingClientRect().width),
    columns: firstRowCells(cells).length,
    overflows: scrollArea.scrollHeight > scrollArea.clientHeight,
  };
}

/**
 * 🔴 THE VIEWPORT -> GRID CHAIN, DRIVEN END TO END.
 *
 * Every other fixture in this PR sets the grid's width directly on a wrapper. That is the
 * right shape for testing the LADDER, and it is blind to the step in front of it: how the
 * grid's width is DERIVED from the viewport. That derivation is where the ladder's most
 * quoted numbers come from, and it is not what the retired implementation did.
 *
 * WHAT CHANGED, AND IT IS A REAL BEHAVIOUR CHANGE, KEPT DELIBERATELY. The page's scroll
 * container is `.scroll-area` (`AppLayout` -> `ScrollArea`), which `globals.css` gives
 * `overflow-x: hidden` + `scrollbar-width: thin`; `html, body { overflow: hidden }` means
 * there is no document scroll, so the apps `Container` sits INSIDE a scrollbar-consuming
 * box. `Grid.Col span` compiled to media queries, which evaluate against the VIEWPORT and
 * are unaffected by a scrollbar. A container query measures the real box. So on platforms
 * that reserve a scrollbar every rung now fires ~10px of viewport later than it used to:
 *
 *   viewport 1200 -> grid 1158 -> THREE columns, where the media query said four.
 *
 * That is the more correct answer — the content never had those 10px — which is why the
 * behaviour is kept and the "byte-equivalent below 1888" claim was retired instead. The
 * equivalence that survives is stated as a function of GRID width, not viewport width.
 *
 * 🔴 WHAT THIS HARNESS STRUCTURALLY CANNOT SEE, MEASURED RATHER THAN ASSUMED. Playwright
 * launches headless Chromium with `--hide-scrollbars`, and this repo's vitest config does
 * not pass `ignoreDefaultArgs`. Probed directly: a genuinely overflowing `.scroll-area`
 * with `scrollbar-width: thin` reports `offsetWidth - clientWidth === 0`. So the NATIVE
 * reserve is zero here and no test in this project can exercise the real 10px delta
 * without changing the browser launch args for both browser projects — out of scope for
 * this PR, and a change that would move every existing geometry number.
 *
 * The tests below split that honestly. Three of the four drive the real chain end-to-end —
 * one at a narrow viewport, two at wide ones so BOTH halves of the ladder are covered — and
 * assert the relationship that holds on every platform (the grid is derived from the scroll
 * box, through the real `MainContent`). 🔴 NONE of those three can tell a container query
 * from a media query, because at reserve 0 the box and the viewport are the same number;
 * measured, all three stay green under the `@container` → `@media` mutant. ALL of the
 * box-vs-viewport discrimination lives in the FOURTH, which reproduces the production case
 * by narrowing the box by `THIN_SCROLLBAR_PX` and is deterministic in any harness. The
 * `expect(reserve).toBe(0)` in the first is a config tripwire, not a guard.
 */
describe('🔴 the grid width comes from the SCROLL BOX, not from the viewport', () => {
  /**
   * ⚠️ THIS TEST HAS NO DISCRIMINATING POWER ON BOX-VS-VIEWPORT, deliberately stated so it
   * is not counted as coverage it does not provide. With the harness reserve at 0 the box
   * and the viewport are the same number, so `columns === listingGridColumnsAt(gridWidth)`
   * holds under a media-query implementation too — measured: this test stays GREEN under
   * the `@container` → `@media` mutant. What it does buy is the CHAIN (that the grid is
   * derived from the scroll box's `clientWidth` minus the Container gutter at all, through
   * the real `MainContent`) and the tripwire below. All of the box-vs-viewport
   * discrimination lives in the next test.
   */
  test('the real chain: grid width === scroll box clientWidth − the Container gutter', async () => {
    const VIEWPORT = { width: 1200, height: 800 };
    const m = await renderRealChain(VIEWPORT);

    // The fixture is only meaningful if the container really scrolls — otherwise there
    // would be no scrollbar to reserve on any platform and the whole question is moot.
    expect(m.overflows, 'the scroll container does not overflow, so nothing would reserve').toBe(
      true
    );

    // 🔴 THE RELATIONSHIP, which is true with or without a scrollbar: the ladder reads the
    // box it is in. A media-query implementation would instead track `window.innerWidth`,
    // and the two only agree while the reserve is 0.
    expect(m.gridWidth).toBe(m.availableInBox - APPS_CONTAINER_GUTTER);
    expect(m.columns).toBe(listingGridColumnsAt(m.gridWidth));

    // 🔴 A CONFIG TRIPWIRE, NOT A GUARD — and the distinction is worth being blunt about.
    // It CANNOT fail while `vitest.config.mts` passes no `ignoreDefaultArgs`, because
    // Playwright's `--hide-scrollbars` makes the reserve 0 unconditionally. So it buys
    // exactly one thing: if a Playwright bump or a config change ever starts reserving
    // scrollbar space, this goes red and the docstring above stops being able to rot
    // silently. It is NOT evidence about production, and NOT an assertion that production
    // reserves nothing.
    expect(
      m.reserve,
      'this harness has started reserving scrollbar width — the docstring above says it ' +
        'does not, and the second test below simulates what it cannot show natively'
    ).toBe(0);
    // …so, and only because of that, the box here equals the viewport.
    expect(m.availableInBox).toBe(VIEWPORT.width);
  });

  /**
   * 🔴 THE WIDE RUNGS, THROUGH THE SAME REAL CHAIN. Without this, `renderRealChain` was
   * called twice and both times at 1200x800 — so the viewport→grid step was exercised only
   * around rungs 3 and 4, and the wide rungs (2364 / 2840) were reached exclusively through
   * `renderAtGridWidth`, which sets a width on a wrapper: the exact shape this file's own
   * header calls "blind to the step in front of it". The claim that both halves of the
   * ladder are driven end-to-end is only true with this test present.
   *
   * Both viewports are mid-band, not on a rung: 2300 → 2268 of grid (the four-column band
   * runs 1168–2363) and 2500 → 2468 (five-column, 2364–2839).
   *
   * ⚠️ LIKE TEST 1, THESE DO NOT DISCRIMINATE BOX FROM VIEWPORT. With the harness reserve
   * at 0 the two numbers coincide, so a media-query implementation passes them — measured:
   * both stay GREEN under the `@container` → `@media` mutant. What they DO buy is the
   * chain at the wide rungs (and they die to the `px-2`-on-`<main>` mutant, which is the
   * link they are really guarding). All box-vs-viewport discrimination in this file lives
   * in the reserved-scrollbar test below, and nowhere else.
   */
  test.each([
    { viewportWidth: 2300, gridWidth: 2268, columns: 4 },
    { viewportWidth: 2500, gridWidth: 2468, columns: 5 },
  ])(
    'the real chain at viewport $viewportWidth gives $gridWidth of grid and $columns columns',
    async ({ viewportWidth, gridWidth, columns }) => {
      const m = await renderRealChain({ width: viewportWidth, height: 900 });
      expect(m.overflows).toBe(true);
      expect(m.gridWidth).toBe(m.availableInBox - APPS_CONTAINER_GUTTER);
      expect(m.gridWidth).toBe(gridWidth);
      expect(m.columns).toBe(columns);
      expect(m.columns).toBe(listingGridColumnsAt(m.gridWidth));
    }
  );

  test('🔴 with a thin scrollbar reserved, viewport 1200 gives THREE columns, not four', async () => {
    // THE PRODUCTION-SHAPED CASE, and the one the retired media queries got wrong. At a
    // 1200px viewport the `lg` breakpoint fires and `Grid.Col span` gave FOUR columns
    // regardless of the scrollbar. The grid actually has 1200 − 10 − 32 = 1158px, which is
    // one pixel short of the four-column rung (1168), so three is the honest answer.
    const VIEWPORT = { width: 1200, height: 800 };
    const m = await renderRealChain(VIEWPORT, VIEWPORT.width - THIN_SCROLLBAR_PX);

    expect(m.availableInBox).toBe(VIEWPORT.width - THIN_SCROLLBAR_PX);
    expect(m.gridWidth).toBe(1158);
    expect(
      m.columns,
      'the ladder is tracking the viewport rather than the box it is in — four columns ' +
        'here is the retired media-query answer, and it truncates every card by the ' +
        'width the scrollbar took'
    ).toBe(3);

    // Stated as the counterfactual, so the test says what it rules out: the `lg` rung
    // fires at viewport 1200 but needs 1168 of GRID, which this box does not have.
    expect(MANTINE_BREAKPOINT_PX.lg).toBe(VIEWPORT.width);
    expect(listingGridColumnsAt(VIEWPORT.width - APPS_CONTAINER_GUTTER)).toBe(4);
    expect(listingGridColumnsAt(m.gridWidth)).toBe(3);
  });
});

describe('🔴 the store grid stretches its cards, so their action rows stay pinned', () => {
  test('the harness loaded the REAL cascade (positive control — Tailwind must resolve)', async () => {
    // 🔴 THE CONTROL THIS FILE EXISTS BECAUSE OF. Without Tailwind's utilities `h-full` is
    // inert, the card's height follows its content, and every measurement below reproduces
    // the DEFECT's numbers on correct code. `tailwindFlexUtilityResolves` is `false` under
    // the `component` tier's DEFAULT setup and `true` here, so it is evidence rather than a
    // reassurance. (It would also be `true` in a `component` spec that imports
    // `~/styles/globals.css` itself — three do. What such a spec still would not have is
    // the layer-ORDER declaration; see the header.)
    await renderAtGridWidth(2450);
    const evidence = cascadeEvidence();
    expect(
      evidence.tailwindFlexUtilityResolves,
      'Tailwind utilities did not resolve — the real cascade did not load'
    ).toBe(true);
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
