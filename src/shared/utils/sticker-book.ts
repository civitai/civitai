/**
 * Who may see what on a creator's sticker book.
 *
 * Zero imports so both the service and the tab can ask the same question, and so
 * the rules can be asserted without a database or a React tree.
 *
 * Two independent opt-outs, both stored as `hide*` booleans with `false` as the
 * absent value — an account that has never opened the settings modal has a
 * visible book showing the stickers it owns, which is what was decided. Storing
 * the positive ("showStickerBook") would make every account that predates this
 * feature read as hidden.
 */
/**
 * Where the grid stops widening, and how much of it the profile tab shows.
 *
 * Seven is the ceiling every other grid on the site uses — `MasonryProvider`
 * defaults `maxColumnCount` to 7 — and the tab's fetch is two full rows of it.
 *
 * 🔴 They live together because the fetch is a ROW COUNT wearing a number: a
 * limit that is not a whole multiple of the ceiling leaves the tab's last row
 * short, which is the report this pair was written for. Multiplied rather than
 * written as 14 so the two cannot drift apart.
 *
 * 🔴 AND the tab's candidate window must stay inside the drill-in's first page:
 * `TAB_LIMIT * OVERFETCH + 1 <= PAGE_LIMIT`. Today that is 29 <= 30 — one row of
 * headroom. Break it and the tab can show cards that "View all" page 1 does not,
 * which surfaces as "nothing here yet" under a full row. Raising the columns or
 * the rows does NOT carry the page size with it; there is a test on this.
 */
export const STICKER_BOOK_MAX_COLUMNS = 7;
export const STICKER_BOOK_TAB_ROWS = 2;
export const STICKER_BOOK_TAB_LIMIT = STICKER_BOOK_MAX_COLUMNS * STICKER_BOOK_TAB_ROWS;

/** One page of the "View all" drill-in. */
export const STICKER_BOOK_PAGE_LIMIT = 30;

/**
 * How far past the page a section looks so the image filter cannot under-fill
 * it. Lives here rather than in the service so the containment invariant below
 * can be asserted against the drill-in's page size.
 */
export const STICKER_BOOK_OVERFETCH = 2;

export type StickerBookSettings = {
  hideStickerBook?: boolean;
  hidePurchasedStickers?: boolean;
};

export type StickerBookViewer = {
  isOwner: boolean;
  isModerator: boolean;
};

export type StickerBookAccess = {
  /** The book itself — the sections, the counts, the totals. */
  canViewBook: boolean;
  /** The grid of stickers this creator owns. */
  canViewStickers: boolean;
  /**
   * How many uses they hold. The owner's alone, and NOT granted to moderators:
   * both toggles are overridden for them, and this is not one of the toggles —
   * it is private in both settings, for everyone. (Ellie: "I don't need to know
   * that.")
   */
  canViewQuantities: boolean;
  /** Buzz earned from placements. Money, so owner and moderators only. */
  canViewEarnings: boolean;
  /** A moderator is being shown something the creator hid. Say so on the page. */
  moderatorOverride: boolean;
};

export function stickerBookAccess(
  settings: StickerBookSettings | null | undefined,
  { isOwner, isModerator }: StickerBookViewer
): StickerBookAccess {
  const bookHidden = settings?.hideStickerBook === true;
  const stickersHidden = bookHidden || settings?.hidePurchasedStickers === true;
  // Deliberately not `isOwner || isModerator` folded into one flag: a moderator
  // is not the owner, and the two diverge on quantities below.
  const privileged = isOwner || isModerator;

  return {
    canViewBook: privileged || !bookHidden,
    canViewStickers: privileged || !stickersHidden,
    canViewQuantities: isOwner,
    canViewEarnings: privileged,
    moderatorOverride: !isOwner && isModerator && (bookHidden || stickersHidden),
  };
}
