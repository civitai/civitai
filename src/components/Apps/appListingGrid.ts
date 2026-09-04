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
 * 🔴 THE MINIMUM CARD WIDTH A NEW, WIDER RUNG OF THE LADDER MUST HOLD, px — the
 * constant the 5- and 6-column thresholds are DERIVED from, so a threshold can never
 * be moved without moving this.
 *
 * ── WHY 460, AND WHY IT IS NOT "THE NARROWEST CARD WE EVER SHIPPED" ─────────────────
 * 460 is the card width the store renders TODAY at its widest: four columns in the
 * 1920 container, `(1920 − 32 gutter − 3 × 16 gap) / 4 = 460`. It is a PRODUCT
 * decision, taken deliberately over the alternative: a floor set at the narrowest
 * width the 2026-07 "larger covers" pass was willing to ship (four columns at a 1600
 * container = `(1600 − 32 − 48) / 4 = 380`) would have put SIX columns on a 2560
 * monitor at 408px each — i.e. widening the container would have made cards SMALLER
 * than they are now, partially reversing that pass at exactly the viewports it should
 * help most. Bigger cards were chosen over more of them.
 *
 * ⚠️ THE HISTORICAL "~383" IS WRONG AND IS NOT WHAT THIS IS. `appListingGrid.ts` and
 * its test both carried "~383 px at 1600" since the covers pass; the arithmetic is
 * 380. Neither number is this constant — do not "restore" either of them here.
 *
 * ── 🔴 460 COLLIDES WITH THE OLD CONTAINER, AND THAT IS A TRAP, NOT A COINCIDENCE ───
 * `4 × 460 + 3 × 16 = 1888` — exactly the content width of the RETIRED 1920 container.
 * So IF this floor ever governed the narrow half of the ladder, four columns would
 * require 1888 of grid and the `xl` low end (viewport 1408 → 1376 of grid) would
 * silently drop to THREE columns, destroying the below-1888 equivalence this change
 * is built on — at a width nobody would think to test, because it used to be the safe
 * middle of the range.
 *
 * It does not, and cannot: {@link LISTING_GRID_COLUMN_STEPS} builds its narrow rungs
 * from {@link LISTING_GRID_SPAN} + {@link MANTINE_BREAKPOINT_PX} and never reads this
 * constant, so the two halves are structurally independent. That independence is
 * asserted directly — 4 columns at 1376, at 1887 and at 1888 — and mutation-checked
 * in `__tests__/appListingGrid.test.ts` by making the floor govern everywhere and
 * watching the 1376 rung go red. Do not remove those assertions on the grounds that
 * the derivation "obviously" cannot do this; the collision is what makes them cheap
 * to lose and expensive to be without.
 *
 * It is NOT a `min-width` handed to CSS. See {@link LISTING_GRID_COLUMN_STEPS} for why
 * an intrinsic `repeat(auto-fill, minmax(…, 1fr))` grid cannot express this ladder at
 * all — this constant is the DERIVATION of the explicit thresholds, not a value any
 * stylesheet reads.
 */
export const LISTING_CARD_MIN_WIDTH = 460;

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
 *
 * 🔴 SIX IS DECLARED BUT UNREACHABLE AT TODAY'S CONTAINER CAP, ON PURPOSE. At the 460
 * floor six columns need `6 × 460 + 5 × 16 = 2840` of grid, and
 * {@link APPS_PAGE_CONTAINER_WIDTH} (2560) tops out at 2528 — so the ladder a viewer
 * can actually reach is 1 / 2 / 3 / 4 / 5, and 2560 renders five columns at 492.8px
 * each (wider than today's 460, which is the point of the floor). The rung is kept
 * rather than deleted so a future cap raise engages it automatically instead of
 * needing this list edited; `__tests__/appListingGrid.test.ts` asserts the
 * unreachability explicitly, so raising the cap past 2840 fails loudly and the density
 * decision gets made deliberately rather than inherited.
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
 * at 1376 gives FIVE at 1888, which lands a 364.8px card — narrower than the 380px the
 * 2026-07 covers pass deliberately moved TO when it went five columns → four, and far
 * under the 460 this grid now holds. So an intrinsic grid would silently undo that pass
 * at exactly the width most desktops use. The column count therefore stays an explicit
 * decision per width band.
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
 * ── HOW THE TWO HALVES ARE BUILT, AND WHY THEY ARE INDEPENDENT ──────────────────────
 * The NARROW rungs (1 / 2 / 3 / 4) are DERIVED from {@link LISTING_GRID_SPAN} and
 * {@link MANTINE_BREAKPOINT_PX} rather than retyped, so the container-query thresholds
 * are the media-query behaviour they replaced, converted once: a breakpoint fires at
 * viewport `V`, `/apps` takes no body measure, and the apps `Container` is full-bleed
 * below its cap, so the grid there is `V − APPS_CONTAINER_GUTTER` wide. `lg` and `xl`
 * both mean four columns, so the `xl` rung collapses into the `lg` one and the ladder
 * has no redundant step.
 *
 * The WIDE rungs come from {@link WIDE_COLUMN_COUNTS} through
 * {@link minContentWidthForColumns}, i.e. straight out of the card-width floor.
 *
 * 🔴 THE LOOP BELOW NEVER READS {@link LISTING_CARD_MIN_WIDTH} FOR A NARROW RUNG, AND
 * THAT SEPARATION IS LOAD-BEARING RATHER THAN TIDY. At the current 460 floor,
 * `minContentWidthForColumns(4)` is 1888 — so a version of this that let the floor
 * decide everywhere would move four columns from 1168 to 1888 and drop the whole
 * 1168–1887 band (the `xl` low end included) to THREE columns. See the collision note
 * on {@link LISTING_CARD_MIN_WIDTH}.
 *
 * The resulting table (grid width → columns) and its equality with the `@container`
 * rules in `AppListingsMarketplaceBody.module.scss` are both pinned in
 * `__tests__/appListingGrid.test.ts` — which also pins 4 columns at 1376 / 1887 / 1888
 * and mutation-checks the independence above. The RENDERED column counts are measured
 * in `AppListingsMarketplaceBody.columns.browser.test.tsx`.
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
 * 364.8px — narrower than what that pass shipped. The 2560 step adds ONE column, and
 * only where every card is still at least the 460px the store renders today: five from
 * 2364px of grid, giving 492.8px cards at the 2528 `/apps` reaches. Six would need 2840
 * and is therefore unreachable at this cap — so widening the container makes the cards
 * BIGGER than they are now rather than more numerous and smaller. The arithmetic is
 * pinned in `__tests__/appsPageWidths.test.ts` and `__tests__/appListingGrid.test.ts`.
 */
export const LISTING_STORE_CONTAINER_SIZE: number = APPS_PAGE_CONTAINER_WIDTH;
