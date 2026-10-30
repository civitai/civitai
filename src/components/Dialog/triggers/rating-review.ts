import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { RatingReviewModalProps } from '~/components/RatingReview/RatingReviewModal';

const RatingReviewModal = dynamic(() => import('~/components/RatingReview/RatingReviewModal'), {
  ssr: false,
});

export const openRatingReviewModal = (props: RatingReviewModalProps) =>
  dialogStore.trigger({ id: 'rating-review', component: RatingReviewModal, props });
