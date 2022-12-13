import { Modal } from '@mantine/core';
import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export const reviewLightboxSchema = z.object({
  reviewId: z.number(),
});

export default createRoutedContext({
  schema: reviewLightboxSchema,
  element: ({ context, props }) => {
    return (
      <Modal opened={context.opened} onClose={context.close}>
        {props.reviewId}
      </Modal>
    );
  },
});
