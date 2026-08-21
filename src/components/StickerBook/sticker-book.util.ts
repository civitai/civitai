export const STICKER_BOOK_SIDES = ['placer', 'owner'] as const;
export type StickerBookSide = (typeof STICKER_BOOK_SIDES)[number];

export function isStickerBookSide(value: unknown): value is StickerBookSide {
  return STICKER_BOOK_SIDES.includes(value as StickerBookSide);
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
  const countLabel = (count: number) => `${count} stickers`;

  if (side === 'placer')
    return {
      title: isOwner ? 'Images you stickered' : `Images ${username} stickered`,
      empty: isOwner
        ? "You haven't had a sticker accepted on anyone else's image yet."
        : 'Nothing here yet.',
      countLabel,
    };

  return {
    title: isOwner
      ? 'Your images that got stickered'
      : `${username}'s images that got stickered`,
    empty: isOwner
      ? 'Nobody has put a sticker on your work yet. Accepted placements show up here.'
      : 'Nothing here yet.',
    countLabel,
  };
}
