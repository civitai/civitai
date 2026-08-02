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
 * Container width per `/apps/*` route, keyed by the NEXT ROUTE PATHNAME (the
 * `src/pages` path, `[param]` segments included) so a reader can map an entry to
 * a file without guessing.
 *
 * Every rendering `/apps/*` route must appear here or in
 * {@link APPS_FULL_BLEED_PAGES}/{@link APPS_REDIRECT_ONLY_PAGES} — enforced by a
 * unit test that walks `src/pages/apps` on disk, so a NEW apps page cannot ship
 * without an explicit width decision.
 */
export const APPS_PAGE_WIDTHS = {
  // ── Wide: grids + wide tables ────────────────────────────────────────────
  /** The store grid. Paired with `LISTING_GRID_SPAN` — see the 🔴 note above. */
  '/apps': APPS_WIDE_PAGE_WIDTH,
  '/apps/installed': APPS_WIDE_PAGE_WIDTH,
  /**
   * Was 1500, a number derived from `SUBMISSIONS_TABLE_MIN_WIDTH` (1424) plus
   * chrome so the submissions table stopped scrolling on desktop. 1920 is
   * strictly wider, so that property is preserved — the table's scroll container
   * remains the safety net below 1424 + chrome.
   */
  '/apps/my-submissions': APPS_WIDE_PAGE_WIDTH,
  '/apps/review': APPS_WIDE_PAGE_WIDTH,
  '/apps/review/[publishRequestId]': APPS_WIDE_PAGE_WIDTH,
  '/apps/revenue': APPS_WIDE_PAGE_WIDTH,

  // ── Readable: forms + detail ─────────────────────────────────────────────
  /** The submit wizard — a form, so measure beats space. */
  '/apps/submit': APPS_READABLE_PAGE_WIDTH,
  /** The listing detail page. */
  '/apps/store-preview/[slug]': APPS_READABLE_PAGE_WIDTH,
  /** The owner's tabbed manifest/media editor. */
  '/apps/[appBlockId]/edit': APPS_READABLE_PAGE_WIDTH,
  /** Per-app revenue detail. */
  '/apps/[appBlockId]/revenue': APPS_READABLE_PAGE_WIDTH,
  /** Retired legacy app detail (still renders for a direct hit). */
  '/apps/[appBlockId]': APPS_READABLE_PAGE_WIDTH,
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
] as const;
