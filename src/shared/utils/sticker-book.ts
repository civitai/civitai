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
