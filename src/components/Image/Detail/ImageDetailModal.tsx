import { Modal } from '@mantine/core';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ImageDetail } from '~/components/Image/Detail/ImageDetail';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImagesContextState } from '~/components/Image/Providers/ImagesProvider';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';

export default function ImageDetailModal({
  imageId,
  images,
  hideReactionCount,
  filters,
}: {
  imageId: number;
  filters?: Record<string, unknown>;
} & ImagesContextState) {
  const dialog = useDialogContext();
  const { query } = useBrowserRouter();
  const queryFilters = imagesQueryParamSchema.parse({ ...filters, ...query });

  if (!query.imageId) return null;

  return (
    <Modal
      {...dialog}
      withCloseButton={false}
      fullScreen
      padding={0}
      style={{ maxHeight: '100dvh', maxWidth: '100vw' }}
    >
      <ImageDetailProvider
        imageId={imageId}
        filters={queryFilters}
        images={images}
        hideReactionCount={hideReactionCount}
      >
        <ImageDetail />
      </ImageDetailProvider>
    </Modal>
  );
}
