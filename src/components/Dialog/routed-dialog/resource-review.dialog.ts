import type ResourceReviewModal from '~/components/ResourceReview/ResourceReviewModal';
import { routedDialog } from '~/components/Dialog/routed-dialog/utils';

export const resourceReviewDialog = routedDialog<typeof ResourceReviewModal>({
  target: '#main',
  resolve: (query, { reviewId }) => ({
    query: { ...query, reviewId },
  }),
});
