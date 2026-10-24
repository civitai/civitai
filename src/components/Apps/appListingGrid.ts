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
 * 🔴 `lg` AND `xl` MOVED 3 → 4 (i.e. four columns → THREE) IN THE RAIL RE-TUNE, AND
 * THAT IS THE COMMIT THIS FILE'S REVIEWER IS BEING ASKED TO SIGN OFF. The legacy
 * breakpoint half now tops out at THREE columns; four and five are placed by the wide
 * half below, which starts at 2242px of grid. Consequence, stated as the cost rather
 * than as the mechanism: **the 1600–2240 band drops from four store columns to three.**
 *
 * Why, in one line: the `/apps` nav became a 276px left rail, which the store grid pays
 * for out of its own width. Against the OLD ladder a 1600 viewport kept four columns and
 * each card shrank 377.5 → 308.5px, and 1920 shrank 457.5 → 388.5 — i.e. the rail would
 * have partially undone the 2026-07 "make app cover images larger" pass at exactly the
 * two most common desktop widths. Dropping a column instead spends the loss on FEWER,
 * WIDER cards, which is the direction both prior passes chose deliberately: every
 * viewport now renders a card WIDER than it does today.
 *
 * ── 🔴 THE COMPLETE COST TABLE, BY VIEWPORT — read this, not the summary sentence ─────
 * Every row is `grid = min(viewport − 10 scrollbar, 2560) − 32 gutter − rail`, where
 * `rail` is 276 at ≥1300 and 0 below it (the stylesheet hides it). "today" is the OLD
 * ladder with NO rail, which is what ships on `main`.
 *
 *   viewport   today          after          rail?   column change
 *   1210       4 × 280.0      3 × 378.7      NO      4 → 3
 *   1280       4 × 297.5      3 × 402.0      NO      4 → 3
 *   1299       4 × 302.3      3 × 408.3      NO      4 → 3
 *   1300       4 × 302.5      3 × 316.7      yes     4 → 3
 *   1440       4 × 337.5      3 × 363.3      yes     4 → 3
 *   1600       4 × 377.5      3 × 416.7      yes     4 → 3
 *   1920       4 × 457.5      3 × 523.3      yes     4 → 3
 *   2100       4 × 502.5      3 × 583.3      yes     4 → 3
 *   2405       4 × 578.8      3 × 685.0      yes     4 → 3
 *   2406       5 × 460.0      3 × 685.3      yes     5 → 3  ← TWO rungs
 *   2500       5 × 478.8      3 × 716.7      yes     5 → 3  ← TWO rungs
 *   2559       5 × 490.6      3 × 736.3      yes     5 → 3  ← TWO rungs
 *   2560       5 × 490.8      4 × 548.5      yes     5 → 4
 *   3440       5 × 492.8      4 × 551.0      yes     5 → 4
 *
 * 🔴 TWO ROWS OF THAT TABLE ARE NOT WHAT THE HEADLINE SENTENCE SAYS, AND BOTH WERE
 * INVISIBLE IN THE FIRST DRAFT OF THIS COMMENT, WHICH SAMPLED 1300/1440/1600/1920/2560
 * AND SKIPPED EVERYTHING BETWEEN THE LAST TWO:
 *   • **2406–2559 loses TWO rungs, 5 → 3.** At 2500 that is five 478.8px cards becoming
 *     three 716.7px ones. The band exists because the OLD five-column rung (2364 of grid)
 *     was reachable without a rail from viewport 2406 up, while the NEW four-column rung
 *     (2242) is not reachable WITH one until 2560. Nothing in the summary sentence covers
 *     it.
 *   • **1210–1299 loses a rung with NO RAIL ON SCREEN** — the stylesheet's
 *     `@media (min-width: 1300px)` has not fired, so these viewers pay the density and
 *     receive no chrome. 1280×800 laptops sit squarely in it.
 * Both found by an adversarial audit re-deriving the two ladders rather than reading the
 * table. If you are re-deriving this, enumerate the BAND, never a handful of round
 * viewports: the interesting widths are the ones adjacent to a retired rung, and no
 * round number lands near 2406.
 *
 * ⚠️ THAT COST FELL ON VIEWERS WHO NEVER SAW A RAIL, AND IT IS WHY THE RE-TUNE WAS
 * REVERTED. The rung is a GLOBAL constant on GRID width while the rail is a CONDITIONAL
 * per-viewer cost, so no-rail, below-1300 and collapsed viewers paid a column they had
 * the width for. See {@link WIDE_COLUMN_COUNTS} for the measurements and why a
 * rail-aware rung is not buildable at this layer.
 *
 * ⚠️ A NARROWER RAIL DOES NOT AVOID THIS — measured, not assumed. A 200px rail keeps
 * four columns at 1440 but at 283.5px each, which is worse than either option here.
 *
 * 🔴 THE COST BAND IS WIDER THAN "1600–2240 OF VIEWPORT, RAIL OPEN", AND THE HONEST
 * STATEMENT IS IN **GRID** WIDTH: everything from **1168 to 2839** loses a column (4→3
 * below 2242, 5→4 above 2364), except the sliver 2242–2363. This ladder is a GLOBAL
 * constant keyed on grid width, while the rail is a CONDITIONAL, per-viewer cost — so
 * three populations pay the density drop and receive no rail at all:
 *
 *   1. the `< 2 sections` cohort, which `apps-sections.ts` and `AppsPageLayout` both
 *      name as LIVE (a store-visible non-author with no installs and no
 *      `appBlocksGetStarted`). `/apps` is their only page, `hasRail` is false, and at a
 *      1920 viewport they go from 4 × 457.5px to 3 × 615.3px;
 *   2. every viewport 1210–1299, where `AppsPageLayout.module.scss` sets
 *      `.rail { display: none }` — grid 1168–1257, so 4 → 3 with no rail rendered;
 *   3. anyone who COLLAPSES the rail. `submissionsTable.ts` offers that as the sanctioned
 *      remedy for the accepted `/apps/build` scroll; it restores the table's width, but
 *      it restores the store's fourth column only in the viewport band 2356–2559 — at
 *      1920 collapsed the grid is 1806 and still three columns.
 *
 * None of that is an arithmetic error in the numbers above (they reproduce), and none of
 * it is a reason to hold the change. It is what a designer has to be shown: the rung is
 * applied UNCONDITIONALLY, so "the rail buys you a wider card" is not the whole trade for
 * every viewer. The open question, recorded rather than silently decided: should the
 * four-column rung be RAIL-STATE-AWARE (the grid is already inside a container query, so
 * the ladder legitimately could differ by rail state), or is a flat rung the intent?
 * Raised by an adversarial round-0 audit; deliberately NOT resolved in code here, because
 * it is the product call the sign-off exists to make.
 *
 * `base` / `sm` / `md` are UNCHANGED (12 → 1 col, 6 → 2, 4 → 3) — and the reason is that
 * their COLUMN COUNTS were already what the re-tune wants, not that their viewports are
 * narrow.
 *
 * ⚠️ THIS SENTENCE USED TO READ "no viewport that narrow renders the rail at all, so
 * nothing below `lg` has a reason to move", AND THE TABLE ABOVE REFUTES THAT RATIONALE
 * TWICE. `lg`'s own band (viewport 1210–1299) renders NO RAIL and moves anyway, 4 → 3;
 * and "renders no rail" was never a reason to be unchanged in the first place, because
 * the rung is a global constant on GRID width and does not ask whether a rail is on
 * screen. A fix round claimed to have removed this and did not — which is how a refuted
 * rationale survives to be reused by the next editor.
 *
 * Historical note, kept because it explains the shape of this object: `xl` was `2.4`
 * (five columns) before the 2026-07 covers pass, which moved it to `3` (four columns)
 * for ~25% more card width. This change continues that direction rather than reversing
 * it.
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
 * ⚠️ THE `em` ↔ `px` QUESTION, STATED CORRECTLY. Mantine's breakpoints are `em` and the
 * container queries below are `px`, so they can only agree at one root size. What
 * follows is narrower and better news than this comment used to claim.
 *
 * 🔴 A CSS `html { font-size }` CANNOT MOVE THEM AT ALL. Inside a MEDIA query, `em`
 * resolves against the browser's INITIAL font size, not the root element's computed one
 * — so an app-level declaration is not a mitigation and its absence is not an exposure.
 * That is a CSS FACT, not a repo measurement: nothing here reproduces it, and it needs
 * no fixture because it follows from the spec — a media query is evaluated against the
 * initial value, outside any element's inherited context. The corollary it buys, also by
 * construction rather than by experiment, is that the ladder cannot INVERT under a root
 * font-size change: the `@media em` breakpoints do not move at all, so the ladder stays
 * monotone non-decreasing in viewport whatever the root size is.
 *
 * 🔴 AND THIS FILE USED TO CITE A SAFEGUARD THAT DOES NOT EXIST: it said "`globals.css`
 * sets `html { font-size: 16px }`". It does not — there is no `html { … }` rule setting
 * a root size (the only `font-size: 16px` is an iOS input-zoom guard inside
 * `@media (hover: none) and (pointer: coarse)`), and the one `html { … }` block is
 * commented out. `cascadeEvidence().htmlFontSize` reads the COMPUTED value, i.e. the UA
 * default, so it can never have been evidence of an app declaration.
 *
 * WHAT REMAINS, honestly: a viewer who has changed their BROWSER's default font size
 * moves the `em` breakpoints while these `px` thresholds stay put. Direction as stated —
 * a larger default yields slightly more columns than the old media queries would have.
 * Unmeasured, and there is no app-level mitigation because none is possible: the
 * alternative, `em` inside a container query, resolves against the CONTAINER's font size
 * rather than the root's and is a third rule again.
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
 * 🔴 THE MINIMUM CARD WIDTH A WIDE RUNG OF THE LADDER MUST HOLD, px.
 *
 * It IS what the wide thresholds are derived from, through
 * {@link minContentWidthForColumns}. ⚠️ A reverted rail re-tune briefly demoted it to a
 * floor that a chrome-derived rung merely had to CLEAR; that rung is gone and the
 * derivation is restored, so moving this constant moves the wide rungs again.
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
 * So IF this floor ever governed the narrow half of the ladder, three columns would be
 * the most the `md`-derived rung could offer and the whole band between it and the wide
 * half would shift — at widths nobody would think to test, because they used to be the
 * safe middle of the range.
 *
 * ⚠️ THE CONCRETE FORM OF THAT TRAP MOVED WITH THE RAIL RE-TUNE, AND THE OLD WORDING IS
 * CORRECTED RATHER THAN DELETED because it is the sentence someone will quote. It used
 * to read: a floor-governed narrow half would push four columns from 1168 to 1888 and
 * drop the `xl` low end (1376 of grid) to three. There is no 1168 rung any more — `lg`
 * and `xl` mean THREE columns now — so 1376 legitimately renders three and the old
 * assertion would be asserting the defect. What survives unchanged is the STRUCTURE:
 * {@link LISTING_GRID_COLUMN_STEPS} builds its narrow rungs from
 * {@link LISTING_GRID_SPAN} + {@link MANTINE_BREAKPOINT_PX} and never reads this
 * constant, so the two halves stay structurally independent — now checked at the
 * `md`-derived three-column rung (960, vs the 1412 a floor-governed one would give) and
 * mutation-checked in `__tests__/appListingGrid.test.ts` by making the floor govern
 * everywhere and watching that rung go red. Do not remove those assertions on the grounds that
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
 * {@link APPS_PAGE_CONTAINER_WIDTH} (2560) tops out at 2528 of grid — so the ladder a
 * viewer can actually reach is 1 / 2 / 3 / 4 / 5, and a 2560 container renders five
 * columns at 492.8px each (wider than today's 460, which is the point of the floor).
 * ⚠️ 2528 / 492.8 are the CONTAINER arithmetic (`2560 − APPS_CONTAINER_GUTTER`), not
 * what a 2560 VIEWPORT yields: see the scroll-box note below. The column count is five
 * either way. The rung is kept
 * rather than deleted so a future cap raise engages it automatically instead of
 * needing this list edited; `__tests__/appListingGrid.test.ts` asserts the
 * unreachability explicitly, so raising the cap past 2840 fails loudly and the density
 * decision gets made deliberately rather than inherited.
 *
 * ⚠️ A rail re-tune briefly replaced this list with hand-written rungs keyed to the
 * rail's width. That is REVERTED — `[5, 6]` is live again, and the paragraphs above
 * describe the ladder that actually ships.
 */

/** One rung of the ladder: at `minContentWidth` px of grid and up, render `columns`. */
export type ListingGridColumnStep = { minContentWidth: number; columns: number };

/**
 * The wide half of the ladder, as COLUMN COUNTS derived from the card-width floor via
 * {@link minContentWidthForColumns} — NOT from the page chrome.
 *
 * ⚠️ THE LEFT-RAIL RE-TUNE THAT USED TO LIVE HERE IS REVERTED. It replaced these counts
 * with hand-written rungs keyed to the rail's own width (a four-column rung at
 * `2560 − 10 − 32 − 276 = 2242`) so that an OPEN rail still reached four columns. The
 * cost was that the ladder is keyed on GRID WIDTH, which cannot tell WHY the grid is
 * narrow — so viewers with no rail at all, with the rail hidden below 1300px, or with it
 * collapsed paid the same lost column despite having the width. Measured: 1440 with no
 * rail went 4 × 338 → 3 × 455, and 2560 with no rail went 5 × 491 → 4 × 618, both well
 * past the 460px floor these rungs derive from.
 *
 * Making the rung rail-aware was considered and rejected as unbuildable at this layer:
 * it needs the rail STATE in the CSS selector, not just the width, because a wider grid
 * must sometimes render FEWER columns (rail-open at 1920 yields 1602px of grid and wants
 * three, while no-rail at 1440 yields 1398px and wants four). No single width-ordered
 * rung set can satisfy both. That would mean three scoped rule sets plus a rewrite of
 * the SCSS↔TS seam parser, on a density surface that must then stay in sync three ways.
 *
 * Reverting confines the whole cost to viewers who OPENED the rail, and leaves every
 * other cohort on exactly the behaviour `main` ships.
 */
const WIDE_COLUMN_COUNTS = [5, 6] as const;

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
 * The NARROW rungs (1 / 2 / 3) are DERIVED from {@link LISTING_GRID_SPAN} and
 * {@link MANTINE_BREAKPOINT_PX} rather than retyped: a breakpoint fires at viewport `V`,
 * `/apps` takes no body measure, and the apps `Container` is full-bleed below its cap,
 * so the rung is placed at `V − APPS_CONTAINER_GUTTER` of GRID. `md`, `lg` and `xl` all
 * mean three columns since the rail re-tune, so they collapse into ONE rung (960) and the
 * ladder has no redundant step.
 *
 * 🔴 THE RUNGS ARE UNCHANGED AS FUNCTIONS OF **GRID** WIDTH — NOT OF VIEWPORT WIDTH, AND
 * THE DIFFERENCE IS A REAL BEHAVIOUR CHANGE THAT IS KEPT ON PURPOSE. This module used to
 * claim the narrow half was "byte-equivalent" to the retired media queries. It is not.
 * The page's scroll container is `.scroll-area` (`AppLayout` → `ScrollArea`), which
 * `src/styles/globals.css` gives `overflow-x: hidden` + `scrollbar-width: thin`, and
 * `html, body { overflow: hidden }` means there is no document scroll — so the apps
 * `Container` sits INSIDE a scrollbar-consuming box and the grid is
 * `viewport − scrollbar − APPS_CONTAINER_GUTTER`. `Grid.Col span` compiled to media
 * queries, which evaluate against the viewport and ignore a scrollbar; a container query
 * measures the box the content actually gets. So on Windows/Linux Chrome/Firefox
 * (~10px thin scrollbar) every rung fires ~10px of VIEWPORT later than it used to —
 * viewport 1200 gives 1158 of grid and THREE columns where the media query said four.
 * macOS overlay scrollbars and touch reserve nothing and are unaffected.
 *
 * That is the more correct answer, because the content never had those pixels, which is
 * why the behaviour is kept and the claim was retired instead. Both halves are driven
 * end-to-end in `AppListingsMarketplaceBody.stretch.geometry.test.tsx`.
 *
 * The WIDE rungs come from {@link WIDE_COLUMN_COUNTS} through
 * {@link minContentWidthForColumns}, i.e. straight out of the card-width floor — one
 * derivation for both, which is what the reverted rail re-tune had split in two.
 *
 * 🔴 THE LOOP BELOW NEVER READS {@link LISTING_CARD_MIN_WIDTH} FOR A NARROW RUNG, AND
 * THAT SEPARATION IS LOAD-BEARING RATHER THAN TIDY. At the current 460 floor,
 * `minContentWidthForColumns(3)` is 1412 — so a version of this that let the floor
 * decide everywhere would move three columns from 960 to 1412 and drop the whole
 * 960–1411 band to TWO columns. See the collision note on
 * {@link LISTING_CARD_MIN_WIDTH}.
 *
 * The resulting table (grid width → columns) and its equality with the `@container`
 * rules in `AppListingsMarketplaceBody.module.scss` are both pinned in
 * `__tests__/appListingGrid.test.ts` — which also pins THREE columns at 1376 / 1888 /
 * 2100 and mutation-checks the independence above. (⚠️ That sentence read "4 columns at
 * 1376 / 1887 / 1888" until the rail re-tune moved the ladder under it; the test asserts
 * three at all of them now, so the old wording named the defect rather than the guard.) The RENDERED column counts are measured
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
    // Dedup: a breakpoint whose column count equals the previous one places NO rung.
    // 🔴 SINCE THE RE-TUNE THIS FIRES TWICE, NOT ONCE — `md`, `lg` and `xl` are all three
    // columns, so `lg` and `xl` BOTH collapse into `md`'s 960 rung and the narrow half is
    // decided entirely by `base` / `sm` / `md`. The comment here used to read "`lg` and
    // `xl` are the same column count — one rung, not two", which understated it and left
    // a reader expecting `lg` to own a rung it no longer has.
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
 * ⚠️ THE PARAGRAPH BELOW DESCRIBES THE PRE-RAIL LADDER AND EVERY LADDER CLAUSE IN IT IS
 * NOW FALSE — "five from 2364px of grid", "492.8px cards", "Six would need 2840 and is
 * therefore unreachable". It is kept as PROVENANCE for the two CONTAINER decisions
 * (1600 → 1920 → 2560), which are unchanged and are what this constant is about; the
 * ladder it quotes has moved to 1/2/3/4/5 at 0/736/960/2242/2840. Two neighbouring stale
 * blocks in this file were given this marker and this one was missed — caught by audit,
 * recorded rather than silently rewritten so the container history stays readable.
 *
 * The full-width pass moved it 1600 → 1920 and the ultrawide pass moved it 1920 → 2560.
 * The 1920 step DELIBERATELY left the column count at four: at 1920 that yields 460px
 * cards (vs 380 at 1600), so the 2026-07 "make app cover images larger" pass got larger
 * still rather than being undone, and re-tuning to five columns there would have landed
 * 364.8px — narrower than what that pass shipped. The 2560 step adds ONE column, and
 * only where every card is still at least the 460px the store renders today: five from
 * 2364px of grid, giving 492.8px cards at the 2528 a 2560 CONTAINER yields (a 2560
 * viewport yields ~10px less on a platform that reserves a scrollbar — still five
 * columns, ~490.8px cards). Six would need 2840
 * and is therefore unreachable at this cap — so widening the container makes the cards
 * BIGGER than they are now rather than more numerous and smaller. The arithmetic is
 * pinned in `__tests__/appsPageWidths.test.ts` and `__tests__/appListingGrid.test.ts`.
 */
export const LISTING_STORE_CONTAINER_SIZE: number = APPS_PAGE_CONTAINER_WIDTH;
