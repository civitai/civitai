import { openDialog } from '~/components/Dialog/openDialog';
import type { RatingReviewModalProps } from '~/components/RatingReview/RatingReviewModal';

export const openRatingReviewModal = (props: RatingReviewModalProps) =>
  openDialog(() => import('~/components/RatingReview/RatingReviewModal'), props, {
    id: 'rating-review',
  });
