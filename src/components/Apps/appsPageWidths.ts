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
 * matched pair with the grid column span in {@link ~/components/Apps/appListingGrid}
 * — the span decides how many cards fit a row, the width decides how wide a row is,
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
 * The ONE container width every `/apps/*` route renders in.
 *
 * 1920 rather than "unbounded": at 2560 an unbounded store grid runs 6+ cards across
 * with the text measure of each card's tagline unchanged, and the wide tables put
 * ~1500px of columns beside ~1000px of whitespace-padded row actions. 1920 is the
 * common wide-desktop width, so on a 1920 monitor the pages are genuinely
 * edge-to-edge and on a 2560 one they stay a readable block.
 *
 * 🔴 IT IS ALSO THE CHROME'S WIDTH, on every route, which is the point of this
 * module. Do not reintroduce a per-page `Container size=` — `AppsPageLayout` no
 * longer accepts one, and `__tests__/appsPageLayout.test.ts` pins that.
 */
export const APPS_PAGE_CONTAINER_WIDTH = 1920;

/**
 * The READABLE measure — single-column form/detail surfaces where line length, not
 * available space, is the constraint. A submit wizard or a listing editor stretched
 * to 1888 puts prose and form rows on an unreadable measure.
 *
 * `1068 = 1100 − 32`: the content width these pages rendered when they passed
 * `size={1100}`. 1100 was chosen as wider than the `sm` (620) / `md` (800) / `lg`
 * (990) tokens these pages used before it — the forms have two-column rows and media
 * grids that were cramped at 620 — while staying inside a comfortable measure.
 */
export const APPS_READABLE_MEASURE = 1068;

/**
 * The NARROW-TABLE measure — a table surface with few, short columns, where the full
 * container is not "full width" but "stretched".
 *
 * `/apps/review` is the case this exists for. It renders FOUR narrow columns (Kind /
 * App / Submitter / Submitted) plus a Review button. At 1888 the columns cannot spend
 * the space, so the table distributes it as padding: Submitter grows to ~380px to
 * hold a short username, and a large dead gap opens between the last column and the
 * Review button, which is the action the moderator is actually aiming at.
 *
 * `1368 = 1400 − 32`: the content width the page rendered at `size={1400}`. 1400 was
 * picked over 1200 to keep the page wider than the readable/form width while stopping
 * short of the width where the row's two ends stop reading as one row.
 *
 * 🔴 A DISTINCT CLASS, deliberately — not a one-off number. The module's rule is "a
 * page joins a class, or the class list grows on purpose"; the guard in
 * `__tests__/appsPageWidths.test.ts` enumerates the classes as literals, so adding a
 * fourth bespoke measure still fails there first. `/apps/mine` is NOT moved here: its
 * table has a measured 1424px scroll floor, so the full container is load-bearing for
 * it in a way it is not for `/apps/review`.
 */
export const APPS_NARROW_TABLE_MEASURE = 1368;

/**
 * The TWO-COLUMN DETAIL measure — a detail page laid out as a main column plus a
 * right rail, where BOTH halves have to be usable at once.
 *
 * `/apps/store-preview/[slug]` is the case this exists for. It is a deliberate port
 * of the MODEL DETAIL page's layout (`<Container size="xl">` in
 * `src/pages/models/[id]/[[...slug]].tsx`) — the same `ContainerGrid2` with the same
 * `{ base: 12, sm: 7, md: 8 }` / `{ base: 12, sm: 5, md: 4 }` spans — so it takes
 * that page's content measure rather than a number of its own.
 *
 * `1288 = 1320 − 32`, and Mantine's `xl` container is 1320 border-box, so 1288 is
 * EXACTLY what the model detail page renders its content at. Stating the equivalence
 * in content terms is what makes it true: `maw={1320}` here would have been 32px
 * wider than the page it claims to match.
 *
 * Why not the READABLE measure it used to be: at 1068 the `md` split gives a ~340px
 * right rail, narrower than the creator card + action card want, and the page reads as
 * a squeezed single column with a sliver beside it. Why not the full container: the
 * left column is prose (a `CustomMarkdown` description), and 8/12 of 1888 is a
 * ~1250px measure — the exact thing {@link APPS_READABLE_MEASURE} exists to avoid. At
 * 1288 the left column is ~825px and the rail ~410px.
 */
export const APPS_TWO_COLUMN_DETAIL_MEASURE = 1288;

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
   * NARROW TABLE, not full width. Four short columns (Kind / App / Submitter /
   * Submitted) cannot spend the container — see {@link APPS_NARROW_TABLE_MEASURE}.
   * The DETAIL route takes no measure at all: it renders side-by-side diff panels +
   * a live preview, which do use the space.
   */
  '/apps/review': APPS_NARROW_TABLE_MEASURE,
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
} as const satisfies Record<string, number>;

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
 */
export const APPS_FULL_MEASURE_PAGES = [
  '/apps',
  '/apps/installed',
  '/apps/mine',
  '/apps/revenue',
  '/apps/review/[publishRequestId]',
] as const;

/**
 * Routes that deliberately have NO container: they host a full-viewport iframe
 * (the block runtime / the moderator's live preview) or a full-bleed dev shell.
 * Capping these would letterbox the app being run/reviewed.
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
