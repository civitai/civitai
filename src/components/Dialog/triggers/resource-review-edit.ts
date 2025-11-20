import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { EditResourceReviewModalProps } from '~/components/ResourceReview/EditResourceReviewModal';

const EditResourceReviewModal = dynamic(
  () => import('~/components/ResourceReview/EditResourceReviewModal'),
  { ssr: false }
);

export function openResourceReviewEditModal(props: EditResourceReviewModalProps) {
  dialogStore.trigger({ component: EditResourceReviewModal, props });
}
