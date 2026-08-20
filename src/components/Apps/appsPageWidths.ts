/**
 * `/apps/*` CONTAINER WIDTHS — one constants module, one decision per route.
 *
 * Why a module and not a `size=` literal per page: before this, every `/apps`
 * surface picked its own width by hand — the store passed a raw `1600`,
 * `/apps/my-submissions` passed `1500` (derived from a table measurement), a few
 * passed a Mantine token (`'lg'` 990 / `'xl'` 1320 / `'sm'` 620), and the rest
 * silently inherited `AppsPageLayout`'s `'xl'` default. Nothing recorded WHY any
 * of them differed, so "make the apps pages full width" had no single place to
 * land and no way to prove it landed everywhere.
 *
 * 🔴 THE PAIR. The store's width is HALF of a matched pair with the grid column
 * span in {@link ~/components/Apps/appListingGrid} — the span decides how many
 * cards fit a row, the width decides how wide a row is, and moving one without
 * the other silently re-truncates (or over-stretches) the cards. That file's
 * `LISTING_STORE_CONTAINER_SIZE` now reads `APPS_PAGE_WIDTHS['/apps']` from here
 * rather than carrying its own copy of the number, and both halves are pinned in
 * `__tests__/appsPageWidths.test.ts` + `__tests__/appListingGrid.test.ts`.
 *
 * "Fluid → max N" is exactly what Mantine's `Container size={N}` already is: a
 * `max-width` with responsive horizontal padding and auto margins. So a page at
 * 1920 fills a 1440px viewport edge-to-edge (minus padding) and only stops
 * growing past 1920 — it is NOT a fixed 1920px box.
 */

/**
 * The WIDE width — the browse/manage surfaces that render a grid or a wide table
 * and are actively hurt by an artificial cap on a large monitor.
 *
 * 1920 rather than "unbounded": at 2560 an unbounded store grid runs 6+ cards
 * across with the text measure of each card's tagline unchanged, and the wide
 * tables (`/apps/my-submissions`, `/apps/review`) put ~1500px of columns beside
 * ~1000px of whitespace-padded row actions. 1920 is the common wide-desktop
 * width, so on a 1920 monitor the pages are genuinely edge-to-edge and on a
 * 2560 one they stay a readable block.
 */
export const APPS_WIDE_PAGE_WIDTH = 1920;

/**
 * The READABLE width — single-column form/detail surfaces where line length, not
 * available space, is the constraint. A submit wizard or a listing detail page
 * stretched to 1920 puts prose on a 1900px measure, which is unreadable.
 *
 * 1100 is wider than the previous `'sm'` (620) / `'md'` (800) / `'lg'` (990)
 * tokens these pages used — the forms have two-column rows and media grids that
 * were cramped at 620 — while staying inside a comfortable measure.
 */
export const APPS_READABLE_PAGE_WIDTH = 1100;

/**
 * The NARROW-TABLE width — a table surface with few, short columns, where 1920 is
 * not "full width" but "stretched".
 *
 * `/apps/review` is the case this exists for. It renders FOUR narrow columns
 * (Kind / App / Submitter / Submitted) plus a Review button. At 1920 the columns
 * cannot spend the space, so the table distributes it as padding: Submitter grows
 * to ~380px to hold a short username, and a large dead gap opens between the last
 * column and the Review button, which is the action the moderator is actually
 * aiming at. The same table reads well at 1200.
 *
 * 1400 rather than 1200: it keeps the page wider than the readable/form width and
 * still fills a 1440 laptop edge-to-edge, while stopping short of the width where
 * the row's two ends stop reading as one row.
 *
 * 🔴 This is a THIRD class, deliberately — not a one-off number. The module's rule
 * is "a page joins a class, or the class list grows on purpose"; the guard in
 * `__tests__/appsPageWidths.test.ts` enumerates the classes, so adding a fourth
 * bespoke width still fails there first. `/apps/my-submissions` is NOT moved here:
 * its table is genuinely wide (a 1424px scroll floor), so 1920 is load-bearing for
 * it in a way it is not for `/apps/review`.
 */
export const APPS_NARROW_TABLE_PAGE_WIDTH = 1400;

/**
 * The TWO-COLUMN DETAIL width — a detail page laid out as a main column plus a
 * right rail, where BOTH halves have to be usable at once.
 *
 * `/apps/store-preview/[slug]` is the case this exists for, and it is a FOURTH class
 * on purpose (the guard in `__tests__/appsPageWidths.test.ts` enumerates the class
 * list as literals, so this could not be added silently — which is the point).
 *
 * 1320 is Mantine's `xl` container, which is what the MODEL DETAIL page uses
 * (`<Container size="xl">` in `src/pages/models/[id]/[[...slug]].tsx`). The listing
 * detail is a deliberate port of that page's layout — the same `ContainerGrid2` with
 * the same `{ base: 12, sm: 7, md: 8 }` / `{ base: 12, sm: 5, md: 4 }` spans — so it
 * takes the same width rather than a number of its own. Matching the source of the
 * design language is the whole reason this class is not just "readable, but bigger".
 *
 * Why not the READABLE 1100 it used to be: at 1100 the `md` split gives a ~350px
 * right rail, which is narrower than the creator card + action card want, and the
 * page reads as a squeezed single column with a sliver beside it. Why not the WIDE
 * 1920: the left column is prose (a `CustomMarkdown` description), and 8/12 of 1888
 * is a ~1250px measure — the exact thing {@link APPS_READABLE_PAGE_WIDTH} exists to
 * avoid. At 1320 the left column is ~845px and the rail ~420px.
 */
export const APPS_TWO_COLUMN_DETAIL_PAGE_WIDTH = 1320;

/**
 * Container width per `/apps/*` route, keyed by the NEXT ROUTE PATHNAME (the
 * `src/pages` path, `[param]` segments included) so a reader can map an entry to
 * a file without guessing.
 *
 * Every rendering `/apps/*` route must appear here or in
 * {@link APPS_FULL_BLEED_PAGES}/{@link APPS_REDIRECT_ONLY_PAGES} — enforced by a
 * unit test that walks `src/pages/apps` on disk, so a NEW apps page cannot ship
 * without an explicit width decision.
 *
 * 🔴 WHAT THE GUARDS DO AND DO NOT ENFORCE — read this before trusting the
 * taxonomy below, because it has already been wrong once.
 *
 * The tests enforce exactly two things:
 *   1. COMPLETENESS — every `/apps/*` page file on disk is listed somewhere, and
 *      every listed route has a page file (the fs walk).
 *   2. CONSUMPTION — every route in `APPS_PAGE_WIDTHS` has a page that actually
 *      reads its width from here, so an entry cannot be dead code.
 *
 * They do NOT enforce CORRECTNESS OF CLASSIFICATION. Nothing checks that a route
 * listed as rendering really renders. `/apps/[appBlockId]` was listed here with
 * the comment "still renders for a direct hit" while the page's own docstring
 * said RETIRED and its `getServerSideProps` unconditionally redirects — so the
 * width was unreachable AND this module asserted a false fact about the app.
 * Deciding which list a route belongs in is a JUDGEMENT that has to be made by
 * reading the page's `getServerSideProps`; a passing test suite is not evidence
 * that it was made correctly.
 */
export const APPS_PAGE_WIDTHS = {
  // ── Wide: grids + wide tables ────────────────────────────────────────────
  /** The store grid. Paired with `LISTING_GRID_SPAN` — see the 🔴 note above. */
  '/apps': APPS_WIDE_PAGE_WIDTH,
  '/apps/installed': APPS_WIDE_PAGE_WIDTH,
  /**
   * `/apps/mine` — the merged author table (it absorbed `/apps/my-submissions`, which now
   * 301s here and has no page file).
   *
   * 🔴 MOVED FROM 1100 TO 1920 WITH THE MERGE, and the reason is the content, not the
   * route. At 1100 this page was a single-column card list; it is now a table carrying an
   * icon, a cover, three badges and a date per row, i.e. the same class of surface as the
   * wide table it replaced (which held this width under its own key). Leaving it readable
   * would have re-created the exact clip the wide width was introduced to fix.
   */
  '/apps/mine': APPS_WIDE_PAGE_WIDTH,
  /**
   * NARROW TABLE, not wide. Four short columns (Kind / App / Submitter /
   * Submitted) cannot spend 1920 — see {@link APPS_NARROW_TABLE_PAGE_WIDTH}. The
   * DETAIL route below stays wide: it renders side-by-side diff panels + a live
   * preview, which do use the space.
   */
  '/apps/review': APPS_NARROW_TABLE_PAGE_WIDTH,
  '/apps/review/[publishRequestId]': APPS_WIDE_PAGE_WIDTH,
  '/apps/revenue': APPS_WIDE_PAGE_WIDTH,

  // ── Readable: forms + detail ─────────────────────────────────────────────
  /** The submit wizard — a form, so measure beats space. */
  '/apps/submit': APPS_READABLE_PAGE_WIDTH,
  /**
   * TWO-COLUMN DETAIL, not readable-single-column. It was 1100 while the body was one
   * stacked column; it is now the model-detail-page layout (main column + right rail),
   * so it takes that page's own width. See {@link APPS_TWO_COLUMN_DETAIL_PAGE_WIDTH}.
   *
   * 🔴 NOT part of the store's matched pair. The pair documented at the top of this file
   * couples `APPS_PAGE_WIDTHS['/apps']` to `LISTING_GRID_SPAN` — verified: the only
   * reader of that pair is `LISTING_STORE_CONTAINER_SIZE`, which indexes `'/apps'`, and
   * nothing in `appListingGrid.ts` reads this route. Moving this number therefore cannot
   * re-truncate a store card.
   */
  '/apps/store-preview/[slug]': APPS_TWO_COLUMN_DETAIL_PAGE_WIDTH,
  /**
   * The LEGACY block-keyed tabbed editor. Still RENDERING, not redirect-only: its
   * `getServerSideProps` 302s to `/apps/listing/<appListingId>/edit` only when the block
   * HAS a listing, and falls through to this page when it does not (a first-version app
   * pending approval has no `AppListing` row). Classified by reading that resolver — see
   * the 🔴 note above about `/apps/[appBlockId]` having been mis-listed once.
   */
  '/apps/[appBlockId]/edit': APPS_READABLE_PAGE_WIDTH,
  /** The CANONICAL listing-keyed authoring editor — serves both store kinds. */
  '/apps/listing/[appListingId]/edit': APPS_READABLE_PAGE_WIDTH,
  /** The invitee's pending-invitation inbox — a short card list. */
  '/apps/invites': APPS_READABLE_PAGE_WIDTH,
  /** Per-app revenue detail. */
  '/apps/[appBlockId]/revenue': APPS_READABLE_PAGE_WIDTH,
  /** The developer get-started explainer — prose. */
  '/apps/get-started': APPS_READABLE_PAGE_WIDTH,
} as const satisfies Record<string, number>;

export type AppsPageRoute = keyof typeof APPS_PAGE_WIDTHS;

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
 * width would be dead code.
 */
export const APPS_REDIRECT_ONLY_PAGES = [
  '/apps/store-preview',
  '/apps/[appBlockId]/edit-manifest',
  '/apps/[appBlockId]/listing',
  /**
   * RETIRED (S8/PR-2). Its `getServerSideProps` unconditionally redirects to
   * `/apps/store-preview/<slug>`; the component body is retained only so a stale
   * bookmark resolves through the hop, and is documented in that file as
   * unreachable. It was briefly listed in {@link APPS_PAGE_WIDTHS} above with the
   * comment "still renders for a direct hit" — which the page itself contradicts.
   * A width there was dead code AND, worse, made this module's own taxonomy
   * assert a false fact about the app.
   */
  '/apps/[appBlockId]',
] as const;
