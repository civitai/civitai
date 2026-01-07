import { useMemo } from 'react';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useCollection } from '~/components/Collections/collection.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { imagesQueryParamSchema } from '~/components/Image/image.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { removeEmpty } from '../../../utils/object-helpers';
import type { ImageGetInfinite } from '~/types/router';

export default function ImageDetailModal({
  imageId,
  images,
  hideReactionCount,
  hideReactions,
  filters,
  collectionId,
}: {
  imageId: number;
  filters?: Record<string, unknown>;
  images?: ImageGetInfinite;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  collectionId?: number;
}) {
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
    <PageModal
      {...dialog}
      withCloseButton={false}
      withinPortal={false}
      withOverlay={false}
      lockScroll={false}
      padding={0}
      fullScreen
    >
      <ImageDetailProvider
        imageId={imageId}
        filters={queryFilters}
        images={images}
        hideReactionCount={hideReactionCount}
        hideReactions={hideReactions}
        collectionId={collectionId}
      >
        <ImageDetail2 />
      </ImageDetailProvider>
    </PageModal>
  );
}
