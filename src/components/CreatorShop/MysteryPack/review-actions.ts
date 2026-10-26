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
  hasLive,
  loaded,
  takenDown = false,
}: {
  status: CosmeticShopItemStatus;
  isMysteryPack: boolean;
  /** `meta.takedown` is set: a takedown ran, and retrying it pays whatever it still owes. */
  takenDown?: boolean;
  /** A mystery pack's pending edit, from its review read. */
  hasEdit: boolean;
  /** Whether the pack has an approved version, from the same read. */
  hasLive: boolean;
  /** Whether that read has loaded; a verdict without it would not name the edit it judged. */
  loaded: boolean;
}) {
  const live = status === CosmeticShopItemStatus.Published;
  if (!isMysteryPack)
    return {
      revert: live,
      remove: live,
      retryTakedown: takenDown && status === CosmeticShopItemStatus.Archived,
      verdicts: !live,
      blocked: false,
      rejectLabel: 'Reject',
      approveLabel: 'Approve & Publish',
      waitingOnCreator: false,
    };
  // The server makes reject final only for a pack never approved; on any other it turns the edit
  // down (or, with none waiting, sends the pack back), so the button must not promise finality.
  const rejectLabel = !hasLive ? 'Reject' : hasEdit ? 'Reject edit' : 'Send back';
  return {
    // Revert needs no edit named, so it doesn't wait for the read.
    revert: live,
    remove: false,
    retryTakedown: false,
    // A rejected pack takes no edits, so it never qualifies.
    verdicts: hasEdit || status === CosmeticShopItemStatus.PendingReview,
    blocked: !loaded,
    rejectLabel,
    approveLabel: hasEdit && hasLive ? 'Approve edit' : 'Approve & Publish',
    waitingOnCreator: loaded && !hasEdit && status === CosmeticShopItemStatus.RequestedChanges,
  };
}
