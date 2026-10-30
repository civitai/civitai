import {
  STICKER_BOOK_MAX_COLUMNS,
  STICKER_BOOK_OVERFETCH,
  STICKER_BOOK_PAGE_LIMIT,
  STICKER_BOOK_TAB_LIMIT,
  STICKER_BOOK_TAB_ROWS,
} from '~/shared/utils/sticker-book';
import { describe, expect, it } from 'vitest';
import { stickerBookAccess } from '~/shared/utils/sticker-book';

const stranger = { isOwner: false, isModerator: false };
const owner = { isOwner: true, isModerator: false };
const moderator = { isOwner: false, isModerator: true };

describe('stickerBookAccess', () => {
  it('shows the book and the stickers to a stranger by default', () => {
    // The absent state, which is every account that predates the feature. If
    // this inverts, the whole thing ships hidden and nobody reports it as a bug.
    const access = stickerBookAccess(undefined, stranger);

    expect(access.canViewBook).toBe(true);
    expect(access.canViewStickers).toBe(true);
    expect(access.moderatorOverride).toBe(false);
  });

  it('hides both from a stranger when the book is hidden', () => {
    const access = stickerBookAccess({ hideStickerBook: true }, stranger);

    expect(access.canViewBook).toBe(false);
    // The stickers are inside the book, so hiding the book has to take them
    // with it — the two toggles are independent as SETTINGS, not as a hierarchy.
    expect(access.canViewStickers).toBe(false);
  });

  it('hides only the stickers when only that toggle is set', () => {
    const access = stickerBookAccess({ hidePurchasedStickers: true }, stranger);

    expect(access.canViewBook).toBe(true);
    expect(access.canViewStickers).toBe(false);
  });

  it('keeps the sticker setting independent of the book setting', () => {
    // A creator who hid their stickers and then hid the whole book still has
    // "stickers hidden" stored; turning the book back on must not republish
    // them.
    const access = stickerBookAccess(
      { hideStickerBook: false, hidePurchasedStickers: true },
      stranger
    );

    expect(access.canViewBook).toBe(true);
    expect(access.canViewStickers).toBe(false);
  });

  it('shows both to a moderator whatever the creator set, and says so', () => {
    const access = stickerBookAccess(
      { hideStickerBook: true, hidePurchasedStickers: true },
      moderator
    );

    expect(access.canViewBook).toBe(true);
    expect(access.canViewStickers).toBe(true);
    expect(access.moderatorOverride).toBe(true);
  });

  it('does not claim an override when the creator hid nothing', () => {
    // Otherwise every moderator viewing an ordinary profile is told the creator
    // is hiding something, which is a false statement about that creator.
    expect(stickerBookAccess({}, moderator).moderatorOverride).toBe(false);
    expect(stickerBookAccess(undefined, moderator).moderatorOverride).toBe(false);
  });

  it('never reports an override to the owner of the book', () => {
    expect(
      stickerBookAccess({ hideStickerBook: true }, { isOwner: true, isModerator: true })
        .moderatorOverride
    ).toBe(false);
  });

  it('keeps quantities to the owner alone, including from moderators', () => {
    // Ellie, in the design session: "I don't need to know that". It is not one
    // of the two toggles, so the moderator override does not reach it.
    expect(stickerBookAccess(undefined, owner).canViewQuantities).toBe(true);
    expect(stickerBookAccess(undefined, moderator).canViewQuantities).toBe(false);
    expect(stickerBookAccess(undefined, stranger).canViewQuantities).toBe(false);
  });

  it('keeps earnings to the owner and moderators', () => {
    expect(stickerBookAccess(undefined, owner).canViewEarnings).toBe(true);
    expect(stickerBookAccess(undefined, moderator).canViewEarnings).toBe(true);
    expect(stickerBookAccess(undefined, stranger).canViewEarnings).toBe(false);
  });

  it('shows the owner their own hidden book', () => {
    const access = stickerBookAccess({ hideStickerBook: true, hidePurchasedStickers: true }, owner);

    expect(access.canViewBook).toBe(true);
    expect(access.canViewStickers).toBe(true);
  });

  it('treats anything other than an explicit true as not hidden', () => {
    // The column is untyped JSON, so a legacy or hand-edited row can carry
    // whatever. Only `true` hides; a truthy string must not.
    const access = stickerBookAccess(
      { hideStickerBook: 'yes', hidePurchasedStickers: 1 } as never,
      stranger
    );

    expect(access.canViewBook).toBe(true);
    expect(access.canViewStickers).toBe(true);
  });
});

describe('the grid constants, which are load-bearing on each other', () => {
  it('fetches WHOLE ROWS of the grid, so the tab never draws a short last row', () => {
    // 🔴 Written as the product, not as 14. The tab's fetch is a row COUNT: a
    // limit that is not a whole multiple of the column ceiling leaves the last
    // row short, which is the report this pair was written for (Ellie,
    // 2026-08-24: "what's the two blank image spots for?").
    expect(STICKER_BOOK_TAB_LIMIT).toBe(STICKER_BOOK_MAX_COLUMNS * STICKER_BOOK_TAB_ROWS);
    expect(STICKER_BOOK_TAB_LIMIT % STICKER_BOOK_MAX_COLUMNS).toBe(0);
  });

  it("keeps the tab's candidate window inside the drill-in's first page", () => {
    // 🔴 The tab overfetches; the drill-in does not. While the tab's window is a
    // subset of page 1, "View all" always shows a superset of the row it was
    // clicked from. Break this and the page can come back EMPTY under a row
    // showing a full grid — and nothing else in the repo checks it, because the
    // page size moves with none of the constants that would break it.
    // Bare, because the failure already names both numbers:
    // `expected 43 to be less than or equal to 30`.
    expect(STICKER_BOOK_TAB_LIMIT * STICKER_BOOK_OVERFETCH + 1).toBeLessThanOrEqual(
      STICKER_BOOK_PAGE_LIMIT
    );
  });
});
