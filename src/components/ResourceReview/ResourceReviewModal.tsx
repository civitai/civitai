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
      // The page modal's ScrollArea must be the scroller, not the modal's content, for the sticky header to hold.
      classNames={{ content: 'flex flex-col overflow-hidden', body: 'min-h-0 flex-1' }}
    >
      <ResourceReviewDetail reviewId={reviewId} />
    </PageModal>
  );
}
