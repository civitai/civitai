import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ResourceReviewDetail } from '~/components/ResourceReview/ResourceReviewDetail';
import { useIsMobile } from '~/hooks/useIsMobile';
import { PageModal } from '../Dialog/Templates/PageModal';

export default function ResourceReviewModal({ reviewId }: { reviewId: number }) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile({ type: 'media' });
  return (
    <PageModal
      {...dialog}
      withCloseButton={false}
      fullScreen={isMobile}
      centered
      size={960}
      radius={16}
      padding={0}
    >
      <ResourceReviewDetail reviewId={reviewId} />
    </PageModal>
  );
}
