import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ResourceReviewDetail } from '~/components/ResourceReview/ResourceReviewDetail';
import { PageModal } from '../Dialog/Templates/PageModal';

export default function ResourceReviewModal({ reviewId }: { reviewId: number }) {
  const dialog = useDialogContext();
  return (
    <PageModal {...dialog} withCloseButton={false} fullScreen size={960} padding={0}>
      <ResourceReviewDetail reviewId={reviewId} />
    </PageModal>
  );
}
