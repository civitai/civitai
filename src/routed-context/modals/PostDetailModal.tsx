import { Modal, Box } from '@mantine/core';
import { z } from 'zod';
import { PostDetail } from '~/components/Post/Detail/PostDetail';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export default createRoutedContext({
  schema: z.object({
    postId: z.number(),
    postSlug: z.string().optional(),
  }),
  Element: ({ context, props }) => {
    return (
      <Modal
        opened={context.opened}
        onClose={() => undefined}
        withCloseButton={false}
        closeOnClickOutside={false}
        fullScreen
        padding={0}
      >
        <Box pt="md" pb="xl">
          <PostDetail {...props} />
        </Box>
      </Modal>
    );
  },
});
