import { Modal } from '@mantine/core';
import { z } from 'zod';
import { GalleryDetail } from '~/components/Gallery/GalleryDetail';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export default createRoutedContext({
  schema: z.object({
    galleryImageId: z.number(),
    modelId: z.number().optional(),
    modelVersionId: z.number().optional(),
    reviewId: z.number().optional(),
    userId: z.number().optional(),
    infinite: z.boolean().optional(),
    returnUrl: z.string().optional(),
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
        <GalleryDetail />
      </Modal>
    );
  },
});
