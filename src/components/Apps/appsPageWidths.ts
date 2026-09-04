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
 * 🔴 2560, RAISED FROM 1920. The old value's stated reason was that "an unbounded
 * store grid runs 6+ cards across at 2560" — i.e. the container was doing the
 * column-count's job, because the grid had no way to add a column deliberately.
 * That is no longer true: {@link ~/components/Apps/appListingGrid} now carries an
 * EXPLICIT column ladder driven by a container query, so the store spends the extra
 * width as a fifth column at the one width where every card still clears the 460px it
 * renders at today, and stops there. The cap and the density are separately decided
 * instead of the cap standing in for the density — and the density decision is that
 * this container makes the cards BIGGER (492.8px at five columns in 2528 of grid),
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
 * ⚠️ SIBLING ROUTES GET WIDER TOO, AND SOME OF THEM DO NOT YET SPEND IT. Every route
 * in {@link APPS_FULL_MEASURE_PAGES} — `/apps/installed`, `/apps/mine`,
 * `/apps/revenue`, `/apps/review/[publishRequestId]` — takes no measure, so its table
 * now lays out at up to 2528px of content. They are correct and unclipped there, but
 * a table that could not spend 1888 cannot spend 2528 either; making those tables use
 * the space is a deliberate follow-up, not part of this change.
 *
 * 🔴 IT IS ALSO THE CHROME'S WIDTH, on every route, which is the point of this
 * module. Do not reintroduce a per-page `Container size=` — `AppsPageLayout` no
 * longer accepts one, and `__tests__/appsPageLayout.test.ts` pins that.
 */
export const APPS_PAGE_CONTAINER_WIDTH = 2560;

/**
 * The READABLE measure — single-column form/detail surfaces where line length, not
 * available space, is the constraint. A submit wizard or a listing editor stretched
 * to the full container (2528px of content today) puts prose and form rows on an
 * unreadable measure.
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
 * App / Submitter / Submitted) plus a Review button. At the full container width the
 * columns cannot spend the space, so the table distributes it as padding: measured at
 * the then-1888px content width, Submitter grew to ~380px to hold a short username and
 * a large dead gap opened between the last column and the Review button, which is the
 * action the moderator is actually aiming at. Raising the container to 2560 (2528 of
 * content) makes that worse, not better — which is why this class exists rather than
 * tracking the container.
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
 * left column is prose (a `CustomMarkdown` description), and 8/12 of the container's
 * content width is a ~1685px measure at today's 2560 (it was ~1250px at 1920) — the
 * exact thing {@link APPS_READABLE_MEASURE} exists to avoid, and the container getting
 * wider only widens the gap. At 1288 the left column is ~825px and the rail ~410px.
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
