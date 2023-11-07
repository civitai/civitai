import { Modal } from '@mantine/core';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ImageDetail } from '~/components/Image/Detail/ImageDetail';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { ImagesInfiniteModel } from '~/server/services/image.service';

export default function ImageDetailModal({
  imageId,
  images,
}: {
  imageId: number;
  images?: ImagesInfiniteModel[];
}) {
  const dialog = useDialogContext();
  const { query } = useBrowserRouter();
  const filters = imagesQueryParamSchema.parse(query);

  if (!query.imageId) return null;

  return (
    <Modal
      {...dialog}
      withCloseButton={false}
      fullScreen
      padding={0}
      style={{ maxHeight: '100dvh', maxWidth: '100vw' }}
    >
      <ImageDetailProvider imageId={imageId} filters={filters} images={images}>
        <ImageDetail />
      </ImageDetailProvider>
    </Modal>
  );
}
