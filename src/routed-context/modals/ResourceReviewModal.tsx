import { Modal } from '@mantine/core';
import { z } from 'zod';
import { ResourceReviewDetail } from '~/components/ResourceReview/ResourceReviewDetail';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number(),
  }),
  Element: ({ context, props }) => {
    return (
      <Modal
        opened={context.opened}
        onClose={() => undefined}
        withCloseButton={false}
        padding={0}
        style={{ maxWidth: 1200 }}
      >
        <ResourceReviewDetail {...props} />
      </Modal>
    );
  },
});
