import { describe, expect, it } from 'vitest';
import { reviewActions } from '../review-actions';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

const pack = (status: CosmeticShopItemStatus, hasEdit: boolean, loaded = true) =>
  reviewActions({ status, isMysteryPack: true, hasEdit, loaded });

describe('reviewActions', () => {
  // The server refuses a takedown of a box listing and deleting one would orphan the box.
  it('never offers a mystery pack takedown or delete, where a live item gets both', () => {
    expect(
      reviewActions({
        status: CosmeticShopItemStatus.Published,
        isMysteryPack: false,
        hasEdit: false,
        loaded: false,
      })
    ).toMatchObject({ revert: true, remove: true, verdicts: false, blocked: false });
    for (const hasEdit of [true, false])
      expect(pack(CosmeticShopItemStatus.Published, hasEdit).remove).toBe(false);
  });

  it("judges a live pack's edit while it stays on sale", () => {
    expect(pack(CosmeticShopItemStatus.Published, true)).toMatchObject({
      revert: true,
      verdicts: true,
      liveEdit: true,
    });
    expect(pack(CosmeticShopItemStatus.Published, false)).toMatchObject({
      revert: true,
      verdicts: false,
    });
  });

  it('judges a pack in review, with or without an edit (one pulled back has none)', () => {
    expect(pack(CosmeticShopItemStatus.PendingReview, true).verdicts).toBe(true);
    expect(pack(CosmeticShopItemStatus.PendingReview, false)).toMatchObject({
      verdicts: true,
      liveEdit: false,
    });
  });

  it('offers nothing on a rejected pack, and waits on the creator for one sent back', () => {
    expect(pack(CosmeticShopItemStatus.Rejected, false)).toMatchObject({
      revert: false,
      verdicts: false,
    });
    expect(pack(CosmeticShopItemStatus.RequestedChanges, false)).toMatchObject({
      verdicts: false,
      waitingOnCreator: true,
    });
    expect(pack(CosmeticShopItemStatus.RequestedChanges, true)).toMatchObject({
      verdicts: true,
      waitingOnCreator: false,
    });
  });

  // A verdict without the read would go out without the edit it judged.
  it("blocks a pack's verdicts until its review read loads", () => {
    expect(pack(CosmeticShopItemStatus.PendingReview, false, false).blocked).toBe(true);
    expect(pack(CosmeticShopItemStatus.PendingReview, false, true).blocked).toBe(false);
  });
});
