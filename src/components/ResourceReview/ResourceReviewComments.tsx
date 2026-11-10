import { CommentSection } from '~/components/CommentsV3/CommentSection';

export function ResourceReviewComments({ reviewId, userId }: { reviewId: number; userId: number }) {
  return (
    <CommentSection
      entityType="review"
      entityId={reviewId}
      ownerId={userId}
      ownerModerates={false}
      title={null}
      hideSort
    />
  );
}
