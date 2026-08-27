import { APPS_PAGE_CONTAINER_WIDTH } from '~/components/Apps/appsPageWidths';

/**
 * App Store Listings (W13) — the `/apps` store's GEOMETRY constants, split out of
 * the component so they're pinnable in a plain (node-project) unit test rather
 * than by asserting Mantine's generated responsive CSS.
 *
 * They're a matched pair: the column span decides how many cards fit per row and
 * the container width decides how wide a row is, so a change to one without the
 * other silently re-truncates the cards. Keeping both here makes that coupling
 * explicit and makes "the container was NOT changed" a real assertion instead of
 * a code-review promise.
 */

/**
 * Store-grid column span per breakpoint.
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
 */
export const LISTING_GRID_SPAN = {
  base: 12,
  sm: 6,
  md: 4,
  lg: 3,
  xl: 3,
} as const;

/**
 * The container width the `/apps` store grid is sized against (px).
 *
 * 🔴 NO LONGER A LITERAL HERE, AND NO LONGER A PROP. The number lives in
 * `~/components/Apps/appsPageWidths` as {@link APPS_PAGE_CONTAINER_WIDTH}, the ONE
 * container width every `/apps/*` route now renders in; this file re-exports it so
 * the container/span pair stays visible and assertable from the grid side. Two
 * copies of the number is exactly the drift the pairing comment above is trying to
 * prevent — don't inline it back.
 *
 * It used to be passed to `AppsPageLayout size=`. That prop is gone (the shared
 * chrome rendered inside it, so a per-page width moved the sub-nav horizontally
 * between routes). `/apps` takes NO body measure, so its content width still IS the
 * container width and the arithmetic below is unchanged — this constant is now the
 * DERIVATION the grid span is tuned against rather than a value the page hands the
 * layout.
 *
 * 🔴 IT HAS NO PRODUCTION CONSUMER ANY MORE — it is read only by
 * `__tests__/appListingGrid.test.ts` and `__tests__/appsPageWidths.test.ts`. That is
 * deliberate, not dead code left behind: the pair below is arithmetic nobody executes at
 * runtime (the container width is applied by `AppsPageLayout`, the span by the grid), so
 * a named constant read by the tests is the only place the coupling can be STATED and
 * checked. Deleting it would not remove any behaviour; it would remove the only thing
 * that fails when someone moves one half of the pair.
 *
 * The full-width pass moved it 1600 → 1920. The `xl` span was DELIBERATELY left at 3
 * (four columns): at 1920 that yields ~460 px cards (vs ~383 at 1600), so the
 * 2026-07 "make app cover images larger" pass gets larger still rather than being
 * undone. Re-tuning to five columns at `xl` would land ~365 px — narrower than what
 * that pass shipped — so it is not a neutral "keep the density" choice. The
 * arithmetic is pinned in `__tests__/appsPageWidths.test.ts`.
 */
export const LISTING_STORE_CONTAINER_SIZE: number = APPS_PAGE_CONTAINER_WIDTH;
