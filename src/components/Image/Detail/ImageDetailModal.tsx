import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImagesContextState } from '~/components/Image/Providers/ImagesProvider';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { removeEmpty } from '../../../utils/object-helpers';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';

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
  const queryFilters = imagesQueryParamSchema.parse(removeEmpty({ ...query, ...filters }));

  if (!query.imageId) return null;

  return (
    <PageModal {...dialog} withCloseButton={false} fullScreen padding={0}>
      <ImageDetailProvider
        imageId={imageId}
        filters={queryFilters}
        images={images}
        hideReactionCount={hideReactionCount}
      >
        <ImageDetail2 />
      </ImageDetailProvider>
    </PageModal>
  );
}
