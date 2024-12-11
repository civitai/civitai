import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImagesContextState } from '~/components/Image/Providers/ImagesProvider';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { removeEmpty } from '../../../utils/object-helpers';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { useMemo } from 'react';
import { useCollection } from '~/components/Collections/collection.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { BrowsingModeOverrideProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';

export default function ImageDetailModal({
  imageId,
  images,
  hideReactionCount,
  filters,
  collectionId,
}: {
  imageId: number;
  filters?: Record<string, unknown>;
} & ImagesContextState) {
  const dialog = useDialogContext();
  const { query } = useBrowserRouter();
  const queryFilters = useMemo(
    () =>
      !images
        ? imagesQueryParamSchema.omit({ tags: true }).parse(removeEmpty({ ...query, ...filters }))
        : {},
    [query, images]
  );

  // Only do this so that we have it pre-fetched
  const { isLoading } = useCollection(collectionId as number, {
    enabled: !!collectionId,
  });

  if (!query.imageId) return null;

  if (collectionId && isLoading) {
    return <PageLoader />;
  }

  return (
    <PageModal {...dialog} withCloseButton={false} fullScreen padding={0}>
      <ImageDetailProvider
        imageId={imageId}
        filters={queryFilters}
        images={images}
        hideReactionCount={hideReactionCount}
        collectionId={collectionId}
      >
        <ImageDetail2 />
      </ImageDetailProvider>
    </PageModal>
  );
}
