import { Modal, Box } from '@mantine/core';
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
        onClose={context.close}
        withCloseButton={false}
        size={960}
        padding={0}
      >
        <Box pt="xs" pb="xl">
          <ResourceReviewDetail {...props} />
        </Box>
      </Modal>
    );
  },
});
