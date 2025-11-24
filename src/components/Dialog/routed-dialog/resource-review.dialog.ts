import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const ResourceReviewModal = dynamic(
  () => import('~/components/ResourceReview/ResourceReviewModal'),
  { ssr: false }
);

const resourceReviewDialog = routedDialogDictionary.addItem('resourceReview', {
  component: ResourceReviewModal,
  target: '#main',
  resolve: (query, { reviewId }) => ({
    query: { ...query, reviewId },
  }),
});

export type ResourceReviewDialog = typeof resourceReviewDialog;
