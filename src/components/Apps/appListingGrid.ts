import type { MantineSize } from '@mantine/core';

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
 * `/apps` store container width (px), passed to `AppsPageLayout size=`.
 *
 * UNCHANGED at 1600 by the cover/CTA pass — the extra card width comes from the
 * column-count drop above, not from widening the page. Pinned here so a future
 * edit to the grid can't quietly move the container too.
 */
export const LISTING_STORE_CONTAINER_SIZE: MantineSize | number = 1600;
