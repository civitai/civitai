import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

/**
 * Which controls the review queue offers for an item. A mystery pack is judged only while an edit
 * waits or it was pulled back to review: a rejection is final for it, one sent back waits on its
 * creator, and it can't be taken down or deleted from here (the box would outlive its listing).
 */
export function reviewActions({
  status,
  isMysteryPack,
  hasEdit,
  loaded,
}: {
  status: CosmeticShopItemStatus;
  isMysteryPack: boolean;
  /** A mystery pack's pending edit, from its review read. */
  hasEdit: boolean;
  /** Whether that read has loaded; a verdict without it would not name the edit it judged. */
  loaded: boolean;
}) {
  const live = status === CosmeticShopItemStatus.Published;
  if (!isMysteryPack)
    return {
      revert: live,
      remove: live,
      verdicts: !live,
      blocked: false,
      liveEdit: false,
      waitingOnCreator: false,
    };
  return {
    revert: live,
    remove: false,
    verdicts:
      status !== CosmeticShopItemStatus.Rejected &&
      (hasEdit || status === CosmeticShopItemStatus.PendingReview),
    blocked: !loaded,
    // The pack stays on sale whatever the verdict on its edit.
    liveEdit: hasEdit && live,
    waitingOnCreator: loaded && !hasEdit && status === CosmeticShopItemStatus.RequestedChanges,
  };
}
