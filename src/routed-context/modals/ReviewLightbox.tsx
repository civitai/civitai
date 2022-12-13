import { Modal } from '@mantine/core';
import { z } from 'zod';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number(),
  }),
  Element: ({ context, props: { reviewId } }) => {
    return (
      <Modal opened={context.opened} onClose={context.close}>
        {reviewId}
      </Modal>
    );
  },
});
