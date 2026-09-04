import { APPS_CONTAINER_GUTTER, APPS_PAGE_CONTAINER_WIDTH } from '~/components/Apps/appsPageWidths';

/**
 * App Store Listings (W13) — the `/apps` store's GEOMETRY constants, split out of
 * the component so they're pinnable in a plain (node-project) unit test rather
 * than by asserting Mantine's generated responsive CSS.
 *
 * They're a matched pair: the column count decides how many cards fit per row and
 * the container width decides how wide a row is, so a change to one without the
 * other silently re-truncates the cards. Keeping both here makes that coupling
 * explicit and makes "the container was NOT changed" a real assertion instead of
 * a code-review promise.
 */

/**
 * Store-grid column span per breakpoint — the LEGACY, VIEWPORT-BREAKPOINT half of
 * the ladder, retained as the SOURCE the narrow half of
 * {@link LISTING_GRID_COLUMN_STEPS} is derived from.
 *
 * `xl: 3` → FOUR columns on a wide viewport. This is the product-feedback change
 * ("make app cover images larger — fewer columns per row?"): it was `2.4` (five
 * columns), and dropping to four gives each card ~25% more width, which the
 * responsive 16:9 cover in `AppListingCard` turns directly into bigger art.
 *
 * Every other breakpoint is UNCHANGED (base 12 → 1 col, sm 6 → 2, md 4 → 3,
 * lg 3 → 4). Deliberately a one-breakpoint change: the narrower breakpoints were
 * already at a comfortable card width, and widening them would push cards past a
 * readable measure on tablets.
 *
 * 🔴 IT IS NO LONGER PASSED TO A `Grid.Col span=`. The grid moved from Mantine's
 * 12-column `<Grid>` to a CSS grid driven by a CONTAINER query (see
 * {@link LISTING_GRID_COLUMN_STEPS}), because `Grid.Col span` can only read a theme
 * BREAKPOINT — a viewport media query — and `xl` (88em / 1408px) is the top of
 * Mantine's scale here. `src/providers/ThemeProvider.tsx` declares NO custom
 * breakpoints, so there was no breakpoint above 1408 to hang a fifth column on, and
 * adding one would be a site-wide theme change to fix one grid.
 *
 * This object stays because it is the RECORD of the narrow half of the ladder, and
 * `LISTING_GRID_COLUMN_STEPS` is computed from it — so the container-query
 * thresholds below 1888 cannot drift away from the media-query behaviour they
 * replaced without this object moving too.
 */
export const LISTING_GRID_SPAN = {
  base: 12,
  sm: 6,
  md: 4,
  lg: 3,
  xl: 3,
} as const;

/**
 * Mantine's DEFAULT breakpoints, in px.
 *
 * 🔴 THE VALUES ARE MANTINE'S, NOT OURS, AND THAT IS THE POINT OF WRITING THEM DOWN.
 * `src/providers/ThemeProvider.tsx` passes no `breakpoints` key, so the theme is
 * Mantine v7's default scale (`xs` 36em, `sm` 48em, `md` 62em, `lg` 75em, `xl` 88em)
 * at the 16px root font size this app ships. Those are what `Grid.Col span={{sm: …}}`
 * compiled to before the CSS-grid move, so they are what the container-query
 * thresholds below have to reproduce.
 *
 * ⚠️ THE ONE PLACE THE REPRODUCTION IS NOT EXACT. Mantine's breakpoints are `em`, so
 * they scale with the ROOT font size; a container query in px does not. At the
 * default 16px they are identical, and `globals.css` sets `html { font-size: 16px }`
 * (that is what `cascadeEvidence().htmlFontSize` reads in the geometry harness), so
 * the two agree for every viewer who has not overridden it in the browser. A viewer
 * who HAS enlarged their default font gets the px thresholds rather than the em ones
 * — i.e. slightly more columns than before at the same zoom. Accepted deliberately:
 * the alternative is `em` inside a container query, which resolves against the
 * CONTAINER's font size rather than the root's and is a different rule again.
 */
export const MANTINE_BREAKPOINT_PX = {
  base: 0,
  xs: 576,
  sm: 768,
  md: 992,
  lg: 1200,
  xl: 1408,
} as const satisfies Record<keyof typeof LISTING_GRID_SPAN | 'xs', number>;

/**
 * The gap between store cards, px. Mantine's `md` spacing token — the value the grid
 * used as `<Grid gutter="md">` and the value the CSS grid now writes as `gap`.
 */
export const LISTING_GRID_GUTTER = 16;

/**
 * 🔴 THE MINIMUM CARD WIDTH THE WIDE STEPS OF THE LADDER HOLD, px — the constant the
 * 5- and 6-column thresholds are DERIVED from, so a threshold can never be moved
 * without moving this.
 *
 * PROVENANCE, stated precisely because the number has been quoted loosely before.
 * The 2026-07 "make app cover images larger" pass shipped FOUR columns at a 1600px
 * container, i.e. `(1600 − 32 gutter − 3 × 16 gap) / 4 = 380px` per card. That is the
 * narrowest card width that pass was willing to ship, and it is the floor a NEW,
 * WIDER step must not go under — adding a column is only allowed to make each card
 * bigger than the covers pass shipped, never smaller.
 *
 * ⚠️ 383, NOT THE MEASURED 380, AND THE THREE PIXELS ARE DELIBERATE. `appListingGrid`
 * and `appListingGrid.test.ts` have both carried "~383 px at 1600" since that pass;
 * the exact arithmetic is 380. Keeping the documented 383 rather than the measured 380
 * makes the floor three pixels STRICTER (a higher floor pushes each threshold OUT, so
 * a column is added later and every card is wider), which is the safe direction for a
 * constant whose whole job is "never ship a card narrower than the covers pass did".
 * Do not "correct" it downward without re-deriving the thresholds — they are computed
 * from it, so lowering it silently narrows every card at the top of the ladder.
 *
 * It is NOT a `min-width` handed to CSS. See {@link LISTING_GRID_COLUMN_STEPS} for why
 * an intrinsic `repeat(auto-fill, minmax(…, 1fr))` grid cannot express this ladder at
 * all — this constant is the DERIVATION of the explicit thresholds, not a value any
 * stylesheet reads.
 */
export const LISTING_CARD_MIN_WIDTH = 383;

/** The card width `columns` cards get in `contentWidth` px of grid. */
export function listingCardWidthAt(contentWidth: number, columns: number): number {
  return (contentWidth - LISTING_GRID_GUTTER * (columns - 1)) / columns;
}

/**
 * The narrowest grid width at which `columns` cards each still clear
 * {@link LISTING_CARD_MIN_WIDTH} — the inverse of {@link listingCardWidthAt}.
 *
 * `n × floor + (n − 1) × gap`. This is the ONLY place a wide threshold is computed,
 * so "the thresholds are derived from the floor" is a fact about the code rather than
 * a claim in a comment.
 */
export function minContentWidthForColumns(columns: number): number {
  return columns * LISTING_CARD_MIN_WIDTH + (columns - 1) * LISTING_GRID_GUTTER;
}

/**
 * The column counts that are added ABOVE the legacy Mantine ladder, each placed at
 * the narrowest width that holds {@link LISTING_CARD_MIN_WIDTH}.
 *
 * Adding a 7th column is one entry here; its threshold falls out of the floor and
 * cannot be chosen independently.
 */
const WIDE_COLUMN_COUNTS = [5, 6] as const;

/** One rung of the ladder: at `minContentWidth` px of grid and up, render `columns`. */
export type ListingGridColumnStep = { minContentWidth: number; columns: number };

/**
 * 🔴 THE COLUMN LADDER — the store grid's column count as a function of the GRID's own
 * width, not the viewport's.
 *
 * ── WHY AN EXPLICIT LADDER AND NOT AN INTRINSIC `auto-fill` GRID ────────────────────
 * `repeat(auto-fill, minmax(X, 1fr))` is the obvious answer and it CANNOT express this,
 * for any single `X`. With a 16px gap, `auto-fill` fits `floor((W + gap) / (X + gap))`
 * columns, so:
 *
 *   · four columns at the low end of the old `xl` breakpoint — viewport 1408, i.e.
 *     1376 of content — needs `X ≤ 332` (a 332px card);
 *   · four columns at 1888 of content — the widest the old 1920 container reached —
 *     needs `X > 364.8`, because five columns at 1888 is exactly 364.8px each.
 *
 * `X ≤ 332` and `X > 364.8` have no overlap. Any floor low enough to keep four columns
 * at 1376 gives FIVE at 1888, which lands a 364.8px card — narrower than the ~380px the
 * 2026-07 covers pass deliberately moved TO when it went five columns → four. So an
 * intrinsic grid would silently undo that pass at exactly the width most desktops use.
 * The column count therefore stays an explicit decision per width band.
 *
 * ── WHY A CONTAINER QUERY AND NOT A MEDIA QUERY ─────────────────────────────────────
 * Card width is not monotonic in VIEWPORT width, so a viewport breakpoint is the wrong
 * axis: at `base` the grid is one column, so a 390px phone yields a ~356px card — wider
 * than the ~280px a 1200px laptop gets at four columns. What decides whether a card is
 * too narrow is the width of the GRID, and the grid's width is what a container query
 * reads. It is also the only mechanism that can react above 1408px at all without
 * adding a custom Mantine breakpoint, which would be a global theme change made to fix
 * one grid.
 *
 * ── HOW THE TWO HALVES ARE BUILT ────────────────────────────────────────────────────
 * BELOW 1888 the ladder is DERIVED from {@link LISTING_GRID_SPAN} and
 * {@link MANTINE_BREAKPOINT_PX} rather than retyped, so the container-query thresholds
 * are the media-query behaviour they replaced, converted once: a breakpoint fires at
 * viewport `V`, `/apps` takes no body measure, and the apps `Container` is full-bleed
 * below its cap, so the grid there is `V − APPS_CONTAINER_GUTTER` wide. `lg` and `xl`
 * both mean four columns, so the `xl` rung collapses into the `lg` one and the ladder
 * has no redundant step.
 *
 * ABOVE it the rungs come from {@link WIDE_COLUMN_COUNTS} through
 * {@link minContentWidthForColumns}, i.e. straight out of the card-width floor.
 *
 * The resulting table (grid width → columns) and its equality with the `@container`
 * rules in `AppListingsMarketplaceBody.module.scss` are both pinned in
 * `__tests__/appListingGrid.test.ts`; the RENDERED column counts are measured in
 * `AppListingsMarketplaceBody.columns.browser.test.tsx`.
 */
export const LISTING_GRID_COLUMN_STEPS: readonly ListingGridColumnStep[] = (() => {
  const steps: ListingGridColumnStep[] = [];
  for (const [breakpoint, span] of Object.entries(LISTING_GRID_SPAN)) {
    const columns = 12 / span;
    // A breakpoint fires on the VIEWPORT; the grid is the viewport minus the apps
    // Container's own gutter. `base` is 0 and stays 0 rather than going negative.
    const viewport = MANTINE_BREAKPOINT_PX[breakpoint as keyof typeof MANTINE_BREAKPOINT_PX];
    const minContentWidth = Math.max(0, viewport - APPS_CONTAINER_GUTTER);
    // `lg` and `xl` are the same column count — one rung, not two.
    if (steps.length > 0 && steps[steps.length - 1].columns === columns) continue;
    steps.push({ minContentWidth, columns });
  }
  for (const columns of WIDE_COLUMN_COUNTS) {
    steps.push({ minContentWidth: minContentWidthForColumns(columns), columns });
  }
  return steps;
})();

/** How many columns the store grid renders in `contentWidth` px of grid. */
export function listingGridColumnsAt(contentWidth: number): number {
  let columns = LISTING_GRID_COLUMN_STEPS[0].columns;
  for (const step of LISTING_GRID_COLUMN_STEPS) {
    if (contentWidth >= step.minContentWidth) columns = step.columns;
  }
  return columns;
}

/**
 * The container width the `/apps` store grid is sized against (px).
 *
 * 🔴 NO LONGER A LITERAL HERE, AND NO LONGER A PROP. The number lives in
 * `~/components/Apps/appsPageWidths` as {@link APPS_PAGE_CONTAINER_WIDTH}, the ONE
 * container width every `/apps/*` route now renders in; this file re-exports it so
 * the container/ladder pair stays visible and assertable from the grid side. Two
 * copies of the number is exactly the drift the pairing comment above is trying to
 * prevent — don't inline it back.
 *
 * It used to be passed to `AppsPageLayout size=`. That prop is gone (the shared
 * chrome rendered inside it, so a per-page width moved the sub-nav horizontally
 * between routes). `/apps` takes NO body measure, so its content width still IS the
 * container width and the arithmetic below is unchanged — this constant is now the
 * DERIVATION the ladder is tuned against rather than a value the page hands the
 * layout.
 *
 * 🔴 IT HAS NO PRODUCTION CONSUMER ANY MORE — it is read only by
 * `__tests__/appListingGrid.test.ts` and `__tests__/appsPageWidths.test.ts`. That is
 * deliberate, not dead code left behind: the pair below is arithmetic nobody executes at
 * runtime (the container width is applied by `AppsPageLayout`, the column count by the
 * grid's own container query), so a named constant read by the tests is the only place
 * the coupling can be STATED and checked. Deleting it would not remove any behaviour; it
 * would remove the only thing that fails when someone moves one half of the pair.
 *
 * The full-width pass moved it 1600 → 1920 and the ultrawide pass moved it 1920 → 2560.
 * The 1920 step DELIBERATELY left the column count at four: at 1920 that yields 460px
 * cards (vs 380 at 1600), so the 2026-07 "make app cover images larger" pass got larger
 * still rather than being undone, and re-tuning to five columns there would have landed
 * 364.8px — narrower than what that pass shipped. The 2560 step is what finally adds
 * columns, and it adds them only where each card still clears
 * {@link LISTING_CARD_MIN_WIDTH}: five columns from 1979px of grid (383px cards at the
 * threshold, 462.6 at the top of that band) and six from 2378 (383 at the threshold,
 * 408 at the 2528 `/apps` actually reaches at a 2560 container). The arithmetic is
 * pinned in `__tests__/appsPageWidths.test.ts` and `__tests__/appListingGrid.test.ts`.
 */
export const LISTING_STORE_CONTAINER_SIZE: number = APPS_PAGE_CONTAINER_WIDTH;
