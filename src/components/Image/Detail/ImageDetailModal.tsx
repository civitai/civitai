import { useMemo } from 'react';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useCollection } from '~/components/Collections/collection.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { ImageDetailProvider } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetail2 } from '~/components/Image/DetailV2/ImageDetail2';
import { imagesQueryParamSchema, parseImageQueryParams } from '~/components/Image/image.utils';
import type { PostTailDescriptor } from '~/components/Image/AsPosts/usePostImagesWithTail';
import { usePostImagesWithTail } from '~/components/Image/AsPosts/usePostImagesWithTail';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { removeEmpty } from '../../../utils/object-helpers';
import type { ImageGetInfinite } from '~/types/router';

export default function ImageDetailModal({
  imageId,
  images,
  postTail,
  hideReactionCount,
  hideReactions,
  filters,
  collectionId,
  withoutPost,
}: {
  imageId: number;
  filters?: Record<string, unknown>;
  images?: ImageGetInfinite;
  postTail?: PostTailDescriptor;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  collectionId?: number;
  withoutPost?: boolean;
}) {
  const dialog = useDialogContext();
  const { query } = useBrowserRouter();
  const queryFilters = useMemo(
    () =>
      !images
        ? parseImageQueryParams(
            removeEmpty({ ...query, ...filters }),
            imagesQueryParamSchema.omit({ tags: true })
          )
        : {},
    [query, images]
  );

  // Only do this so that we have it pre-fetched
  const { isLoading } = useCollection(collectionId as number, {
    enabled: !!collectionId,
  });

  // A lazy gallery card seeds the post's FIRST SLICE, not the post. Grow it here, or
  // everything past the slice is unreachable from a gallery click (ClickUp 868kxypd0).
  const { images: seededImages } = usePostImagesWithTail({
    seed: images ?? [],
    postId: postTail?.postId,
    filters: postTail?.filters,
    browsingLevel: postTail?.browsingLevel,
    hiddenImageIds: postTail?.hiddenImageIds,
    hiddenTags: postTail?.hiddenTags,
    hiddenUsers: postTail?.hiddenUsers,
    enabled: !!postTail && !!images && images.length < postTail.imageCount,
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
        images={images ? seededImages : undefined}
        hideReactionCount={hideReactionCount}
        hideReactions={hideReactions}
        collectionId={collectionId}
        withoutPost={withoutPost}
      >
        <ImageDetail2 />
      </ImageDetailProvider>
    </PageModal>
  );
}
