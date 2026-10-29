/**
 * How the post page's info panel is pinned to the bottom of a phone screen.
 *
 * Sticky, not fixed: the page scrolls inside `.scroll-area`, whose `will-change: transform` makes it
 * the containing block of any fixed descendant, so a fixed panel scrolled away with the content.
 * Sticky follows the scrollport. `-mx-3` and `self-stretch` span the row's `px-3` gutters.
 */
export const POST_INFO_PANEL_PIN =
  '@max-lg:sticky @max-lg:bottom-0 @max-lg:z-[200] @max-lg:-mx-3 @max-lg:self-stretch';
