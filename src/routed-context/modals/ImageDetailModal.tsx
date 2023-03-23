import { Modal } from '@mantine/core';
import { z } from 'zod';
import { ImageDetail } from '~/components/Image/Detail/ImageDetail';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export default createRoutedContext({
  schema: z.object({
    imageId: z.number(),
    modelId: z.number().optional(),
    modelVersionId: z.number().optional(),
    postId: z.number().optional(),
    username: z.string().optional(),
    userId: z.number().optional(),
  }),
  Element: ({ context, props }) => {
    return (
      <Modal
        opened={context.opened}
        onClose={() => undefined}
        withCloseButton={false}
        fullScreen
        padding={0}
        style={{ maxHeight: '100vh', maxWidth: '100vw' }}
      >
        <ImageDetailProvider {...props}>
          <ImageDetail />
        </ImageDetailProvider>
      </Modal>
    );
  },
});
