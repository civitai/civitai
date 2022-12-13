import { Modal } from '@mantine/core';
import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export const reviewLightboxSchema = z.object({
  reviewId: z.number(),
});

export default createRoutedContext({
  schema: reviewLightboxSchema,
  Element: ({ context, props: { reviewId } }) => {
    // check infinite query cach for review
    // if not there, fetch review details?

    return (
      <Modal opened={context.opened} onClose={context.close}>
        {reviewId}
      </Modal>
    );
  },
});
