import { describe, expect, it } from 'vitest';
import { reviewActions } from '../review-actions';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

const pack = (
  status: CosmeticShopItemStatus,
  { hasEdit = false, hasLive = false, loaded = true } = {}
) => reviewActions({ status, isMysteryPack: true, hasEdit, hasLive, loaded });

describe('reviewActions', () => {
  // Retrying finishes refunds a takedown left owed; nothing else archived has a takedown to finish.
  it('offers Retry takedown only on an archived item that was taken down', () => {
    const item = (status: CosmeticShopItemStatus, takenDown: boolean) =>
      reviewActions({
        status,
        isMysteryPack: false,
        hasEdit: false,
        hasLive: false,
        loaded: true,
        takenDown,
      }).retryTakedown;
    expect(item(CosmeticShopItemStatus.Archived, true)).toBe(true);
    expect(item(CosmeticShopItemStatus.Archived, false)).toBe(false);
    expect(item(CosmeticShopItemStatus.Published, true)).toBe(false);
    expect(
      reviewActions({
        status: CosmeticShopItemStatus.Archived,
        isMysteryPack: true,
        hasEdit: false,
        hasLive: true,
        loaded: true,
        takenDown: true,
      }).retryTakedown
    ).toBe(false);
  });

  // The server refuses a takedown of a box listing and deleting one would orphan the box.
  it('never offers a mystery pack takedown or delete, where a live item gets both', () => {
    expect(
      reviewActions({
        status: CosmeticShopItemStatus.Published,
        isMysteryPack: false,
        hasEdit: false,
        hasLive: false,
        loaded: false,
      })
    ).toMatchObject({ revert: true, remove: true, verdicts: false, blocked: false });
    for (const hasEdit of [true, false])
      expect(pack(CosmeticShopItemStatus.Published, { hasEdit, hasLive: true }).remove).toBe(false);
  });

  it("judges a live pack's edit while it stays on sale", () => {
    expect(pack(CosmeticShopItemStatus.Published, { hasEdit: true, hasLive: true })).toMatchObject({
      revert: true,
      verdicts: true,
      rejectLabel: 'Reject edit',
      approveLabel: 'Approve edit',
    });
    expect(pack(CosmeticShopItemStatus.Published, { hasLive: true })).toMatchObject({
      revert: true,
      verdicts: false,
    });
  });

  // Reject is final on the server only for a pack never approved; elsewhere it sends the pack back.
  it('labels reject as final only for a pack that was never approved', () => {
    expect(pack(CosmeticShopItemStatus.PendingReview, { hasEdit: true })).toMatchObject({
      verdicts: true,
      rejectLabel: 'Reject',
      approveLabel: 'Approve & Publish',
    });
    expect(pack(CosmeticShopItemStatus.PendingReview, { hasLive: true })).toMatchObject({
      verdicts: true,
      rejectLabel: 'Send back',
    });
    expect(
      pack(CosmeticShopItemStatus.PendingReview, { hasEdit: true, hasLive: true }).rejectLabel
    ).toBe('Reject edit');
  });

  it('offers nothing on a rejected pack, and waits on the creator for one sent back', () => {
    expect(pack(CosmeticShopItemStatus.Rejected)).toMatchObject({ revert: false, verdicts: false });
    expect(pack(CosmeticShopItemStatus.RequestedChanges)).toMatchObject({
      verdicts: false,
      waitingOnCreator: true,
    });
    expect(pack(CosmeticShopItemStatus.RequestedChanges, { hasEdit: true })).toMatchObject({
      verdicts: true,
      waitingOnCreator: false,
    });
  });

  // A verdict without the read would go out without the edit it judged; revert names no edit.
  it("blocks a pack's verdicts until its review read loads, never its revert", () => {
    expect(pack(CosmeticShopItemStatus.PendingReview, { loaded: false }).blocked).toBe(true);
    expect(pack(CosmeticShopItemStatus.PendingReview).blocked).toBe(false);
    expect(pack(CosmeticShopItemStatus.Published, { loaded: false }).revert).toBe(true);
  });
});
