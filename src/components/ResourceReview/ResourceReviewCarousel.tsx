import { Button, Loader, Text } from '@mantine/core';
import { IconInfoCircle, IconLibraryPhoto, IconPhotoOff } from '@tabler/icons-react';
import { useState } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Reactions } from '~/components/Reaction/Reactions';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ImageSort } from '~/server/common/enums';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import classes from './ResourceReviewCarousel.module.css';

const GALLERY_LIMIT = 10;
// Beside the large image.
const MAX_THUMBNAILS = 3;

/**
 * The review dialog's gallery: the review's post images when it has a post, else the reviewer's
 * most reacted images of the reviewed version, with a strip linking to the rest.
 */
export function ResourceReviewCarousel({
  userId,
  username,
  modelVersionId,
  reviewId,
  postId,
}: {
  userId: number;
  username: string | null;
  modelVersionId: number;
  reviewId: number;
  postId: number | null;
}) {
  const [activeId, setActiveId] = useState<number | null>(null);
  // Without a post or a username there is nothing to look the images up by.
  const canLoad = !!postId || !!username;

  // today, typescript was not cool.
  // functions will only check extra parameters if it's fresh
  const filters: GetInfiniteImagesInput = postId
    ? { postId, modelVersionId, period: MetricTimeframe.AllTime, limit: GALLERY_LIMIT }
    : {
        userId,
        modelVersionId,
        sort: ImageSort.MostReactions,
        period: MetricTimeframe.AllTime,
        limit: GALLERY_LIMIT,
      };

  const { data, images, isLoading, isError, refetch } = useQueryImages(filters, {
    enabled: canLoad,
  });

  if (!canLoad) return <NoReviewImages />;
  if (isLoading)
    return (
      <div className="flex h-64 items-center justify-center bg-gray-1 dark:bg-dark-8">
        <Loader />
      </div>
    );
  if (isError)
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 bg-gray-1 dark:bg-dark-8">
        <Text c="dimmed">Could not load images for this review.</Text>
        <Button variant="light" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!images.length) return <NoReviewImages />;

  const hasMore = data?.pages.some((x) => x.nextCursor !== undefined) ?? false;
  const large = images.find((image) => image.id === activeId) ?? images[0];
  const thumbnails = images.filter((image) => image.id !== large.id).slice(0, MAX_THUMBNAILS);
  const countLabel = `${images.length}${hasMore ? '+' : ''}`;
  const postTitle = images[0]?.postTitle;
  const viewMoreHref = postId
    ? `/posts/${postId}`
    : `/images?view=feed&periodMode=stats&modelVersionId=${modelVersionId}&userId=${userId}`;

  return (
    <div>
      <div
        className="grid grid-cols-1 gap-2 bg-gray-0 px-5 py-4 md:h-[452px] md:grid-cols-[minmax(0,1fr)_140px] dark:bg-dark-7"
        data-testid="review-gallery"
      >
        <LargeImage key={large.id} image={large} images={images} reviewId={reviewId} />
        {thumbnails.length > 0 && (
          <div className="grid grid-cols-3 gap-2 md:flex md:min-h-0 md:flex-col">
            {thumbnails.map((image) => (
              <ImageGuard2 key={image.id} image={image} connectType="review" connectId={reviewId}>
                {(safe) => (
                  <button
                    type="button"
                    aria-label="Show this image"
                    onClick={() => setActiveId(image.id)}
                    className="relative aspect-square min-h-0 cursor-pointer overflow-hidden rounded-md border-0 bg-gray-2 p-0 md:aspect-auto md:flex-1 dark:bg-dark-6"
                  >
                    {!safe ? (
                      <MediaHash {...image} />
                    ) : (
                      <EdgeMedia
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        type={image.type}
                        width={320}
                        placeholder="empty"
                        className="size-full object-cover"
                      />
                    )}
                  </button>
                )}
              </ImageGuard2>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-b border-solid border-gray-3 px-5 py-2.5 text-[13px] text-gray-6 dark:border-dark-4 dark:text-dark-2">
        <span className="flex min-w-0 items-center gap-2">
          <IconLibraryPhoto size={14} className="shrink-0" />
          <span className="truncate">
            {postId
              ? `${postTitle ? `From the post “${postTitle}”` : 'From the post'} · ${countLabel} ${
                  countLabel === '1' ? 'image' : 'images'
                } made with this version`
              : 'Images made with this version'}
          </span>
        </span>
        <Link
          href={viewMoreHref}
          rel="nofollow"
          className="shrink-0 text-[13px] font-semibold text-blue-6 dark:text-blue-4"
        >
          {postId ? 'View post →' : 'View more →'}
        </Link>
      </div>
    </div>
  );
}

function NoReviewImages() {
  return (
    <div
      className="flex items-center justify-center gap-2 border-b border-solid border-gray-3 bg-gray-0 px-5 py-6 text-sm text-gray-6 dark:border-dark-4 dark:bg-dark-7 dark:text-dark-2"
      data-testid="review-no-images"
    >
      <IconPhotoOff size={20} />
      No images in this review
    </div>
  );
}

function LargeImage({
  image,
  images,
  reviewId,
}: {
  image: ImagesInfiniteModel;
  images: ImagesInfiniteModel[];
  reviewId: number;
}) {
  const features = useFeatureFlags();

  return (
    <ImageGuard2 image={image} connectType="review" connectId={reviewId}>
      {(safe) => (
        <div className="relative aspect-[4/3] min-h-0 overflow-hidden rounded-md bg-gray-2 md:aspect-auto dark:bg-dark-9">
          <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
          <ImageContextMenu image={image} className="absolute right-2 top-2 z-10" />

          <RoutedDialogLink
            name="imageDetail"
            state={{ imageId: image.id, images }}
            className="block size-full"
          >
            {!safe ? (
              <MediaHash {...image} />
            ) : (
              <EdgeMedia
                src={image.url}
                name={image.name ?? image.id.toString()}
                alt={image.name ?? undefined}
                type={image.type}
                width={1200}
                hiDpi={features.hiDpiPreviews}
                sourceWidth={image.width}
                placeholder="empty"
                className="size-full object-cover"
              />
            )}
          </RoutedDialogLink>
          <Reactions
            entityId={image.id}
            entityType="image"
            reactions={image.reactions}
            metricsUnknown={image.stats?.statsUnknown}
            metrics={{
              likeCount: image.stats?.likeCountAllTime,
              dislikeCount: image.stats?.dislikeCountAllTime,
              heartCount: image.stats?.heartCountAllTime,
              laughCount: image.stats?.laughCountAllTime,
              cryCount: image.stats?.cryCountAllTime,
            }}
            readonly={!safe}
            className={classes.reactions}
            targetUserId={image.user.id}
            disableBuzzTip={image.poi}
          />
          {image.hasMeta && (
            <div className="absolute bottom-0.5 right-0.5 z-10">
              <ImageMetaPopover2 imageId={image.id} type={image.type}>
                <LegacyActionIcon component="div" variant="transparent" size="lg">
                  <IconInfoCircle
                    color="white"
                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                    opacity={0.8}
                    strokeWidth={2.5}
                    size={26}
                  />
                </LegacyActionIcon>
              </ImageMetaPopover2>
            </div>
          )}
        </div>
      )}
    </ImageGuard2>
  );
}
