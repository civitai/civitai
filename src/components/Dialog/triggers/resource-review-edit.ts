import { openDialog } from '~/components/Dialog/openDialog';
import type { EditResourceReviewModalProps } from '~/components/ResourceReview/EditResourceReviewModal';

export function openResourceReviewEditModal(props: EditResourceReviewModalProps) {
  openDialog(() => import('~/components/ResourceReview/EditResourceReviewModal'), props);
}
