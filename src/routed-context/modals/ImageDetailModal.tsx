import { Modal } from '@mantine/core';
import { z } from 'zod';
import { ImageDetail } from '~/components/Image/Detail/ImageDetail';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { createRoutedContext } from '~/routed-context/create-routed-context';

export default createRoutedContext({
  schema: imagesQueryParamSchema.extend({ imageId: z.number() }),
  Element: ({ context, props: { imageId, ...filters } }) => {
    return (
      <Modal
        opened={context.opened}
        onClose={() => undefined}
        withCloseButton={false}
        fullScreen
        padding={0}
        style={{ maxHeight: '100vh', maxWidth: '100vw' }}
      >
        <ImageDetailProvider imageId={imageId} filters={filters}>
          <ImageDetail />
        </ImageDetailProvider>
      </Modal>
    );
  },
});
