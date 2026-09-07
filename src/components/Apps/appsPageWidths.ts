/**
 * `/apps/*` GEOMETRY — ONE container for every route, an optional CONTENT MEASURE
 * inside it.
 *
 * 🔴 THE MODEL, AND WHY IT CHANGED. This module used to export `APPS_PAGE_WIDTHS`,
 * a per-route CONTAINER width, and `AppsPageLayout` fed it straight into its
 * `<Container size=…>`. The shared chrome — the {@link ~/components/Apps/AppsSubNav}
 * tab strip — renders INSIDE that Container, so it inherited each page's own width
 * and the one element that is supposed to be identical on every apps page moved
 * horizontally as you navigated. Measured on a real render of `AppsPageLayout`
 * (Chromium, Mantine stylesheet loaded), reading the nav's `getBoundingClientRect()`:
 *
 *                                     @1440           @2560
 *   route                     size    left  width    left  width
 *   /apps                     1920      16   1408     336   1888
 *   /apps/review              1400      36   1368     596   1368
 *   /apps/store-preview/[..]  1320      76   1288     636   1288
 *   /apps/submit              1100     186   1068     746   1068
 *
 * i.e. a 170px left / 340px width spread at 1440 and a 410px / 820px spread at 2560,
 * for a tab strip whose whole job is to stay put. The container is now UNIFORM
 * ({@link APPS_PAGE_CONTAINER_WIDTH}) and the narrowing that some pages genuinely
 * need moved INSIDE the body, below the chrome, as a left-aligned max-width box.
 *
 * The measures below are therefore CONTENT widths, not container widths, and they
 * are the OLD container widths minus the `Container`'s own `2 × 16px` gutter — so
 * every page's rendered content is byte-identical in width to what it was before,
 * and the ONLY thing this change moves is the chrome's alignment. See
 * {@link APPS_CONTAINER_GUTTER} for that arithmetic, which is pinned in
 * `__tests__/appsPageWidths.test.ts`.
 *
 * 🔴 THE PAIR (unchanged in force, and now stronger). The store's width is HALF of a
 * matched pair with the grid column LADDER in {@link ~/components/Apps/appListingGrid}
 * — the ladder decides how many cards fit a row, the width decides how wide a row is,
 * and moving one without the other silently re-truncates (or over-stretches) the
 * cards. `/apps` takes NO measure, so its content width IS the container width, and
 * `LISTING_STORE_CONTAINER_SIZE` reads {@link APPS_PAGE_CONTAINER_WIDTH} rather than
 * carrying its own copy of the number. Both halves stay pinned in
 * `__tests__/appsPageWidths.test.ts` + `__tests__/appListingGrid.test.ts`.
 *
 * "Fluid → max N" is exactly what Mantine's `Container size={N}` already is: a
 * `max-width` with responsive horizontal padding and auto margins. So the apps
 * container fills a 1440px viewport edge-to-edge (minus padding) and only stops
 * growing past 1920 — it is NOT a fixed 1920px box.
 *
 * 🔴 A MEASURE IS A **BAND**, NOT ALWAYS A NUMBER — and that is the second pass.
 * The container went 1920 → 2560 and the routes that take no measure grew with it,
 * but a fixed measure did not: `/apps/submit` rendered the same 1068px of form on a
 * 1440 monitor and on a 2560 one. Prose has a readability CEILING, not a readability
 * WIDTH, so the narrowed routes now carry a {@link AppsMeasureBand} — a floor, a
 * ceiling, and the share of the container they track between the two. See
 * {@link appsMeasureCss} for the CSS it becomes and why the floor is the number the
 * page used to render at.
 */

/**
 * The horizontal gutter Mantine's `Container` reserves — `16px` per side, and it is
 * INSIDE the `max-width` (the component is border-box).
 *
 * 🔴 THIS IS THE WHOLE REASON THE MEASURES ARE NOT ROUND NUMBERS. A page that used to
 * pass `size={1100}` rendered `1100 − 32 = 1068px` of content. A measure box lives
 * INSIDE that gutter, so `maw={1100}` would render `1100px` of content — 32px wider
 * than before. Subtracting the gutter here keeps this change a PURE alignment fix:
 * no page's content width moves, so any visual regression is attributable to the
 * alignment and not to a confounded width change.
 */
export const APPS_CONTAINER_GUTTER = 32;

/**
 * The container width every `/apps/*` route rendered in BEFORE the ultrawide pass,
 * kept as a named literal because two of this module's guards are about NOT MOVING
 * anything below it.
 *
 * It is the reference point for {@link AppsMeasureBand}'s floor: a band must still
 * resolve to its `min` at `1920 − 32 = 1888` of content, so widening a measured
 * route is strictly an ADDITION on screens wider than the old cap, never a change to
 * what a 1440 or 1920 monitor already showed.
 */
export const APPS_LEGACY_CONTAINER_WIDTH = 1920;

/**
 * A CONTENT MEASURE that GROWS WITH THE CONTAINER, between a floor and a ceiling.
 *
 * `min` is the width the route rendered at before it had a band — so nothing moves
 * on the screens that were already measured. `max` is the width past which the
 * surface stops being better for being wider (a prose measure, or a two-column split
 * whose main column would itself become unreadable). `grow` is the PERCENTAGE OF THE
 * CONTAINER'S CONTENT WIDTH the measure tracks between them.
 *
 * 🔴 `grow` IS WHAT MAKES THE BAND A RAMP RATHER THAN A SECOND FIXED NUMBER. With
 * `100%` the box would jump straight to `max` at every desktop width — i.e. a silent
 * re-decision of what a 1440 monitor shows, dressed up as an ultrawide change. The
 * two `grow` values in this file are chosen so that each band is EXACTLY at its `min`
 * at {@link APPS_LEGACY_CONTAINER_WIDTH}'s content width and EXACTLY at its `max` by
 * the current container's; both halves are pinned in `__tests__/appsPageWidths.test.ts`
 * as arithmetic rather than asserted here in prose.
 */
export type AppsMeasureBand = {
  /** px floor — the width this route rendered at before it had a band. */
  readonly min: number;
  /** px ceiling — the width past which more space stops helping this surface. */
  readonly max: number;
  /** % of the container's CONTENT width the measure tracks between floor and ceiling. */
  readonly grow: number;
};

/** A route's content measure: a fixed px width, or a {@link AppsMeasureBand}. */
export type AppsMeasure = number | AppsMeasureBand;

/** Narrow an {@link AppsMeasure} to the band case. */
export function isAppsMeasureBand(measure: AppsMeasure): measure is AppsMeasureBand {
  return typeof measure === 'object' && measure !== null;
}

/**
 * The value handed to the measure box's `maw`.
 *
 * A number passes straight through (Mantine converts it to `rem`). A band becomes a
 * `clamp()`, and the middle term is a PERCENTAGE deliberately: a percentage in
 * `max-width` resolves against the CONTAINING BLOCK, which here is the shared
 * `Container`'s content box — so the ramp is bounded by the container's own cap and
 * keeps working unchanged on a monitor wider than it. `vw` would not: it keeps
 * growing past 2560 while the container has stopped, so the band would reach its
 * ceiling on a screen where the container never widened.
 *
 * 🔴 Mantine's `rem()` passes a `clamp(` string through untouched (it early-returns on
 * that prefix), so this lands in the DOM verbatim rather than being re-scaled.
 */
export function appsMeasureCss(measure: AppsMeasure): number | string {
  if (!isAppsMeasureBand(measure)) return measure;
  return `clamp(${measure.min}px, ${measure.grow}%, ${measure.max}px)`;
}

/**
 * The narrowest column a `/apps/*` CARD LIST may be laid out in before it starts
 * putting cards SIDE BY SIDE instead of stretching each one across the container.
 *
 * 🔴 THIS EXISTS FOR `/apps/installed`, AND FOR ONE MEASURED DEFECT. That page is a
 * `Stack` of full-width cards whose header rows are
 * `<Group justify="space-between" wrap="nowrap">` — content on the left, the control
 * that acts on it on the right. Raising the container to 2560 therefore moved the
 * Manage / Restore button **640px further from the app name it belongs to**, because the
 * row's left cell is `flex: 1` and the surplus lands inside it as dead space.
 *
 * ⚠️ THREE ROWS, NOT FOUR, and the correction is worth keeping because the fourth is a
 * reminder that the SHAPE is not the defect. The rows are in `PinnedInstallRow`,
 * `InstalledAppCard` and `HiddenBlocksPanel` (named rather than cited by line number —
 * this file's own edits moved every one of the line numbers first quoted here).
 * `ScopeGrantsPanel`'s row is `justify="space-between"` too and NOTHING moved in it: it
 * has a SINGLE flex child and no control, so there are no two ends for the space to open
 * between. A grep for the justify prop over-counts; what matters is content-plus-control.
 *
 * A body cap would fix the gap by refusing the width, which is the thing the container
 * pass exists to stop doing. So the width is spent on COLUMNS instead: the card list is
 * a `repeat(auto-fill, minmax(…, 1fr))` grid, and 1200 is picked so the ladder steps
 * exactly where the surplus appeared —
 *
 *   content 1888 (the OLD 1920 container): `floor((1888 + 16) / (1200 + 16))` = **1 column**
 *   content 2528 (the CURRENT container):  `floor((2528 + 16) / (1200 + 16))` = **2 columns**
 *
 * — i.e. nothing a 1440 or 1920 monitor shows changes, and the second column arrives at
 * 2416 of content. Both rungs are pinned in `__tests__/appsWideLayout.test.ts`; the
 * rendered consequence (the gap does not grow) is in
 * `AppsWideLayout.geometry.test.tsx`.
 *
 * 🔴 "NOTHING CHANGES" IS A CLAIM ABOUT SPACING AS WELL AS COLUMN COUNT, which is why
 * `AppsCardGrid` takes a `gap`. The lists it replaced did not share one: the Hidden tab
 * was `<Stack gap="sm">` (12px), the other two `md` (16px). Defaulting all three to 16
 * would have moved 4px on a tab a 1440 monitor shows — small, but the sentence above
 * says NOTHING, and a claim that is 99% true is the kind nobody re-checks. Both gaps
 * produce the SAME rungs at both container widths, so carrying the original number is
 * free; that equivalence is asserted rather than assumed.
 */
export const APPS_CARD_LIST_MIN_COLUMN = 1200;

/** The DEFAULT gap between card-grid tracks, px — Mantine's `md` spacing, stated as a
 *  number because the column arithmetic above needs it. A list that used a different
 *  `Stack` gap passes its own; see `AppsCardGrid`'s `gap` prop. */
export const APPS_CARD_LIST_GAP = 16;

/**
 * The ONE container width every `/apps/*` route renders in.
 *
 * 🔴 2560, RAISED FROM 1920. The old value's stated reason was that "an unbounded
 * store grid runs 6+ cards across at 2560" — i.e. the container was doing the
 * column-count's job, because the grid had no way to add a column deliberately.
 * That is no longer true: {@link ~/components/Apps/appListingGrid} now carries an
 * EXPLICIT column ladder driven by a container query, so the store spends the extra
 * width as a fifth column at the one width where every card still clears the 460px it
 * renders at today, and stops there. The cap and the density are separately decided
 * instead of the cap standing in for the density — and the density decision is that
 * this container makes the cards BIGGER (492.8px at five columns in the 2528 of grid a
 * 2560 container yields; ~490.8px from a 2560 viewport, which loses ~10px more to the
 * scroll container's thin scrollbar on the platforms that reserve one),
 * not more numerous. A sixth column is declared at 2840 of grid and is deliberately
 * unreachable here; raising this constant past that fails a test rather than silently
 * shrinking every card.
 *
 * What 1920 actually cost: Mantine's `Container` centres past its cap, so a 2560
 * viewport spent `(2560 − 1920) / 2 = 320px` of dead margin on EACH side of every
 * `/apps/*` page — and the top of Mantine's own breakpoint scale is `xl` = 88em
 * (1408px), so nothing in the grid could react to any of it either (the theme
 * declares no custom breakpoints; see `src/providers/ThemeProvider.tsx`).
 *
 * 2560 is the common ultrawide/4K-scaled desktop width, so a 2560 monitor is now
 * genuinely edge-to-edge. Past it the pages centre again, which is the same
 * behaviour 1920 gave a 2560 monitor.
 *
 * ✅ THE SIBLING ROUTES NOW SPEND IT — this note used to say they did not. Every route
 * in {@link APPS_FULL_MEASURE_PAGES} lays out at up to 2528px of content, and the
 * surplus goes into COLUMN WIDTHS rather than padding: the tables carry a proportional
 * `<colgroup>` whose PRIMARY column takes the slack, and `/apps/installed`'s card list
 * steps to a second grid column. Both mechanisms live in
 * `~/components/Apps/appsWideLayout` — read {@link APPS_CARD_LIST_MIN_COLUMN} for the
 * measured 640px dead-gap defect the card half fixes.
 *
 * 🔴 `/apps/review` IS IN THAT LIST NOW, AND ITS 1368 CAP IS DELETED. It was the one
 * route whose measure existed to work around this: four short columns could not spend
 * the container, so the table distributed the surplus as padding and the Review button
 * receded from the row it acts on. Capping the page refused the width to avoid
 * mis-spending it; the columns are proportional now, so the workaround would only be
 * hiding the fix. There is no `APPS_NARROW_TABLE_MEASURE` any more — do not
 * reintroduce one for a table that reads too wide; give it a `<colgroup>`.
 *
 * 🔴 IT IS ALSO THE CHROME'S WIDTH, on every route, which is the point of this
 * module. Do not reintroduce a per-page `Container size=` — `AppsPageLayout` no
 * longer accepts one, and `__tests__/appsPageLayout.test.ts` pins that.
 */
export const APPS_PAGE_CONTAINER_WIDTH = 2560;

/**
 * The READABLE measure — single-column form/prose surfaces where line length, not
 * available space, is the constraint. A submit wizard or a listing editor stretched to
 * the full container (2528px of content today) puts prose and form rows on an
 * unreadable measure.
 *
 * A BAND since the ultrawide pass, not the fixed 1068 it was:
 *
 * `min: 1068 = 1100 − 32` — the content width these pages rendered when they passed
 * `size={1100}`. 1100 was chosen as wider than the `sm` (620) / `md` (800) / `lg`
 * (990) tokens these pages used before it — the forms have two-column rows and media
 * grids that were cramped at 620 — while staying inside a comfortable measure. It is
 * the FLOOR rather than the width, so nothing a 1440 or 1920 monitor shows moves.
 *
 * `max: 1368` — the number the deleted narrow-table class carried, and it is reused
 * rather than invented for the reason that class recorded: 1400 (1368 of content) was
 * "wider than the readable/form width while stopping short of the width where the
 * row's two ends stop reading as one row". That judgement is about a two-ended ROW,
 * which is exactly what these pages' form rows are.
 *
 * `grow: 55` — see {@link AppsMeasureBand}. 55% of 1888 (the old container's content)
 * is 1038 ≤ 1068, so the floor still wins there; 55% of 2528 is 1390 ≥ 1368, so the
 * ceiling is reached inside the current container. Both are asserted arithmetically.
 */
export const APPS_READABLE_MEASURE: AppsMeasureBand = { min: 1068, max: 1368, grow: 55 };

/**
 * The TWO-COLUMN DETAIL measure — a detail page laid out as a main column plus a
 * right rail, where BOTH halves have to be usable at once.
 *
 * `/apps/store-preview/[slug]` is the case this exists for. It is a deliberate port
 * of the MODEL DETAIL page's layout (`<Container size="xl">` in
 * `src/pages/models/[id]/[[...slug]].tsx`) — the same `ContainerGrid2` with the same
 * `{ base: 12, sm: 7, md: 8 }` / `{ base: 12, sm: 5, md: 4 }` spans.
 *
 * `min: 1288 = 1320 − 32`, and Mantine's `xl` container is 1320 border-box, so 1288 is
 * EXACTLY what the model detail page renders its content at. Stating the equivalence
 * in content terms is what makes it true: `maw={1320}` here would have been 32px
 * wider than the page it claims to match. Why not the READABLE floor it used to be: at
 * 1068 the `md` split gives a ~340px right rail, narrower than the creator card +
 * action card want, and the page reads as a squeezed single column with a sliver
 * beside it.
 *
 * `max: 1600` — DERIVED, not chosen. The ceiling on this page is the LEFT column: it
 * is prose (a `CustomMarkdown` description) at the `md` 8/12 span, and the readable
 * band's own floor is 1068. `8/12 × 1600 = 1066.67 ≤ 1068`, so 1600 is the widest this
 * page can be while its markdown column stays inside the measure the readable class
 * exists to hold. The rail grows from ~410px to ~533px across the band, which is the
 * half the ultrawide pass was asked for. Letting it track the full container instead
 * would put the description on a ~1685px measure — the exact thing
 * {@link APPS_READABLE_MEASURE} exists to avoid.
 *
 * `grow: 65` — 65% of 1888 is 1227 ≤ 1288 (floor holds at the old container) and 65%
 * of 2528 is 1643 ≥ 1600 (ceiling reached inside the current one).
 */
export const APPS_TWO_COLUMN_DETAIL_MEASURE: AppsMeasureBand = {
  min: 1288,
  max: 1600,
  grow: 65,
};

/**
 * CONTENT MEASURE per `/apps/*` route, keyed by the NEXT ROUTE PATHNAME (the
 * `src/pages` path, `[param]` segments included) so a reader can map an entry to a
 * file without guessing.
 *
 * A route is listed here ONLY if its body should be narrower than the container.
 * Everything else takes the full container and is listed in
 * {@link APPS_FULL_MEASURE_PAGES}. Every rendering `/apps/*` route must appear in one
 * of the four lists in this module — enforced by a unit test that walks
 * `src/pages/apps` on disk, so a NEW apps page cannot ship without an explicit
 * decision.
 *
 * 🔴 WHAT THE GUARDS DO AND DO NOT ENFORCE — read this before trusting the taxonomy
 * below, because it has already been wrong once.
 *
 * The tests enforce exactly three things:
 *   1. COMPLETENESS — every `/apps/*` page file on disk is listed somewhere, and
 *      every listed route has a page file (the fs walk).
 *   2. CONSUMPTION — every route in {@link APPS_PAGE_MEASURES} has a page that
 *      actually reads its measure from here, so an entry cannot be dead code.
 *   3. LAYOUT ADOPTION — every rendering route imports and renders `AppsPageLayout`,
 *      which is what makes the chrome uniform in the first place.
 *
 * They do NOT enforce CORRECTNESS OF CLASSIFICATION. Nothing checks that a route
 * listed as rendering really renders. `/apps/[appBlockId]` was once listed with the
 * comment "still renders for a direct hit" while the page's own docstring said
 * RETIRED and its `getServerSideProps` unconditionally redirects — so the width was
 * unreachable AND this module asserted a false fact about the app. Deciding which
 * list a route belongs in is a JUDGEMENT that has to be made by reading the page's
 * `getServerSideProps`; a passing test suite is not evidence that it was made
 * correctly.
 */
export const APPS_PAGE_MEASURES = {
  /**
   * TWO-COLUMN DETAIL, not readable-single-column — the model-detail-page layout
   * (main column + right rail), so it takes that page's content measure.
   *
   * 🔴 NOT part of the store's matched pair. The pair documented at the top of this
   * file couples {@link APPS_PAGE_CONTAINER_WIDTH} to `LISTING_GRID_SPAN`; the only
   * reader of that pair is `LISTING_STORE_CONTAINER_SIZE`, and nothing in
   * `appListingGrid.ts` reads this route. Moving this number cannot re-truncate a
   * store card.
   */
  '/apps/store-preview/[slug]': APPS_TWO_COLUMN_DETAIL_MEASURE,
  /** The submit wizard — a form, so measure beats space. */
  '/apps/submit': APPS_READABLE_MEASURE,
  /** The invitee's pending-invitation inbox — a short card list. */
  '/apps/invites': APPS_READABLE_MEASURE,
  /**
   * The LEGACY block-keyed tabbed editor. Still RENDERING, not redirect-only: its
   * `getServerSideProps` 302s to `/apps/listing/<appListingId>/edit` only when the
   * block HAS a listing, and falls through to this page when it does not (a
   * first-version app pending approval has no `AppListing` row). Classified by
   * reading that resolver — see the 🔴 note above about `/apps/[appBlockId]` having
   * been mis-listed once.
   */
  '/apps/[appBlockId]/edit': APPS_READABLE_MEASURE,
  /** The CANONICAL listing-keyed authoring editor — serves both store kinds. */
  '/apps/listing/[appListingId]/edit': APPS_READABLE_MEASURE,
  /** Per-app revenue detail. */
  '/apps/[appBlockId]/revenue': APPS_READABLE_MEASURE,
  /** The developer get-started explainer — prose. */
  '/apps/get-started': APPS_READABLE_MEASURE,
} as const satisfies Record<string, AppsMeasure>;

export type AppsMeasuredRoute = keyof typeof APPS_PAGE_MEASURES;

/**
 * Rendering routes that take the FULL container — the browse/manage surfaces that
 * render a grid or a wide table and are actively hurt by an artificial cap on a large
 * monitor. They pass no `measure` to `AppsPageLayout` at all.
 *
 * 🔴 `/apps/mine` is here, not in {@link APPS_PAGE_MEASURES}, and the reason is the
 * content rather than the route: it absorbed `/apps/my-submissions` (which now 301s
 * here and has no page file) and is a table carrying an icon, a cover, three badges
 * and a date per row, with a measured `SUBMISSIONS_TABLE_MIN_WIDTH` scroll floor of
 * 1424px. Giving it the readable measure would re-create the exact clip the wide
 * width was introduced to fix; `__tests__/appsPageWidths.test.ts` pins the container
 * against that floor.
 *
 * 🔴 `/apps/review` JOINED THIS LIST when its 1368 cap was deleted — see the note on
 * {@link APPS_PAGE_CONTAINER_WIDTH}. Taking the full container is only correct for it
 * because its queue table now carries `APPS_REVIEW_QUEUE_COLUMNS`; the two changes are
 * one decision and reverting either alone re-opens the dead-gap defect.
 */
export const APPS_FULL_MEASURE_PAGES = [
  '/apps',
  '/apps/installed',
  '/apps/mine',
  '/apps/revenue',
  '/apps/review',
  '/apps/review/[publishRequestId]',
] as const;

/**
 * Routes that deliberately have NO `AppsPageLayout` container: they host a
 * full-viewport iframe (the block runtime / the moderator's live preview) or a
 * full-bleed dev shell. Wrapping these in the apps container would letterbox the
 * app being run/reviewed AND put a second chrome band over a third-party app.
 *
 * 🔴 "NO CONTAINER" IS NOT "NO WIDTH BOUND" — it stopped being that, and this
 * comment used to assert the stronger claim. All three of these routes mount
 * `PageBlockHost`, which caps ITSELF at `--app-page-max-width` (1600px, see
 * `APP_PAGE_MAX_WIDTH_PX` in `~/components/AppBlocks/PageBlockHost`) and centres
 * the app past that. Two different mechanisms at two very different thresholds:
 * this module's container is 2560 and applies to the apps CHROME, the host's cap
 * is 1600 and applies to the app itself, and an app can be excused from the
 * host's via the CSS ledger in `src/styles/globals.css`. Nothing here changes —
 * these routes still pass no `measure` and still render no `AppsPageLayout` — but
 * do not read this list as evidence that a run page is unbounded.
 */
export const APPS_FULL_BLEED_PAGES = [
  '/apps/run/[slug]/[[...path]]',
  '/apps/review/preview/[publishRequestId]',
  '/apps/dev/[blockId]',
] as const;

/**
 * Routes whose `getServerSideProps` always redirects or 404s — their default
 * export exists only to satisfy Next's page contract and never renders, so a
 * measure would be dead code.
 */
export const APPS_REDIRECT_ONLY_PAGES = [
  '/apps/store-preview',
  '/apps/[appBlockId]/edit-manifest',
  '/apps/[appBlockId]/listing',
  /**
   * RETIRED (S8/PR-2). Its `getServerSideProps` unconditionally redirects to
   * `/apps/store-preview/<slug>`; the component body is retained only so a stale
   * bookmark resolves through the hop, and is documented in that file as
   * unreachable. It was briefly listed as a rendering route with the comment "still
   * renders for a direct hit" — which the page itself contradicts. A width there was
   * dead code AND, worse, made this module's own taxonomy assert a false fact about
   * the app.
   */
  '/apps/[appBlockId]',
] as const;
