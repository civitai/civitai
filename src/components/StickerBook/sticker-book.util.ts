export const STICKER_BOOK_SIDES = ['placer', 'owner'] as const;
export type StickerBookSide = (typeof STICKER_BOOK_SIDES)[number];

export function isStickerBookSide(value: unknown): value is StickerBookSide {
  return STICKER_BOOK_SIDES.includes(value as StickerBookSide);
}

/**
 * The book's route, written once.
 *
 * Beside the copy below for the same reason: a rename gets fixed in the spellings
 * someone greps and missed in the one they don't.
 */
export function stickerBookUrl(username: string) {
  return `/user/${username}/sticker-book`;
}

/**
 * Every string a section is described by, in one place.
 *
 * The row on the tab and the page behind its "View all" are the same section,
 * and a creator who followed a link headed "Images you stickered" onto a page
 * headed something else has been told they are somewhere they are not. Written
 * once so the two cannot drift.
 *
 * The second person is used only for the owner. "Your images that got stickered"
 * on someone else's profile is the kind of copy that reads fine in review and
 * wrong in use.
 */
export function stickerBookSectionCopy(
  side: StickerBookSide,
  { username, isOwner }: { username: string; isOwner: boolean }
) {
  if (side === 'placer')
    return {
      title: isOwner ? 'Images you stickered' : `Images ${username} stickered`,
      empty: isOwner
        ? "You haven't had a sticker accepted on anyone else's image yet."
        : 'Nothing here yet.',
    };

  return {
    title: isOwner ? 'Your images that got stickered' : `${username}'s images that got stickered`,
    empty: isOwner
      ? 'Nobody has put a sticker on your work yet. Accepted placements show up here.'
      : 'Nothing here yet.',
  };
}

/**
 * The prefix of `items` that fills COMPLETE rows of a `columnCount`-wide grid.
 *
 * Extracted from the grid so it can be tested without a DOM: the column count
 * arrives from a ResizeObserver behind a 100ms debounce, and component tests
 * load no stylesheet, so any "at this viewport, expect N cards" assertion is
 * measuring an unstyled width. The contract has no width in it — given a column
 * count, draw `floor(n / c) * c`.
 *
 * 🔴 Both guards are load-bearing, and both fail the same alarming way. Fewer
 * items than columns must return them ALL, and a column count of 0 — which is
 * what the provider reports until it has measured — must pass through. Either
 * one removed returns an empty array, and the grid then tells a viewer who has
 * hidden nobody that "Everything here is from creators you have hidden."
 */
export function wholeRows<T>(items: T[], columnCount: number): T[] {
  if (!columnCount || items.length < columnCount) return items;
  return items.slice(0, Math.floor(items.length / columnCount) * columnCount);
}
