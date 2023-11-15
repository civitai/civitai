import { Modal, Box } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ResourceReviewDetail } from '~/components/ResourceReview/ResourceReviewDetail';

export default function ResourceReviewModal({ reviewId }: { reviewId: number }) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} withCloseButton={false} size={960} padding={0}>
      <Box pt="xs" pb="xl">
        <ResourceReviewDetail reviewId={reviewId} />
      </Box>
    </Modal>
  );
}
