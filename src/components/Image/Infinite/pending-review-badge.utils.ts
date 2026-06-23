import { CollectionItemStatus } from '~/shared/utils/prisma/enums';

export function shouldShowPendingReviewBadge(
  image: { userId: number; collectionItemStatus?: string | null },
  currentUserId?: number
): boolean {
  return (
    !!currentUserId &&
    image.userId === currentUserId &&
    image.collectionItemStatus === CollectionItemStatus.REVIEW
  );
}
