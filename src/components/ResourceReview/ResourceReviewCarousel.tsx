import { Button, Loader, Text } from '@mantine/core';
import { IconInfoCircle, IconLibraryPhoto, IconPhotoOff } from '@tabler/icons-react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Reactions } from '~/components/Reaction/Reactions';
import { useReviewImages } from '~/components/ResourceReview/useReviewImages';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import classes from './ResourceReviewCarousel.module.css';

const MAX_IMAGES = 8;
// The tallest an image gets, so a portrait fits the dialog without cropping.
const MAX_IMAGE_HEIGHT = '60vh';
const SLIDE_CLASS =
  'flex flex-[0_0_100%] items-center justify-center pl-3 md:flex-[0_0_50%] md:pl-6';

/**
 * The review dialog's gallery: up to eight of the images its `imageCount` counts, each shown whole,
 * with a final slide linking to the rest.
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
  const mobile = useIsMobile({ type: 'media' });
  // Without a post or a username there is nothing to look the images up by.
  const canLoad = !!postId || !!username;

  // One more than shown, to know whether there are more.
  const {
    images: fetched,
    isLoading,
    isError,
    refetch,
  } = useReviewImages({ reviewId, limit: MAX_IMAGES + 1 }, { enabled: canLoad });
  const images = fetched.slice(0, MAX_IMAGES);

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

  const hasMore = fetched.length > MAX_IMAGES;
  const totalSlides = images.length + (hasMore ? 1 : 0);
  const fits = mobile ? 1 : 2;
  const postTitle = images[0]?.postTitle;
  const viewMoreHref = postId
    ? `/posts/${postId}`
    : `/images?view=feed&periodMode=stats&modelVersionId=${modelVersionId}&userId=${userId}`;

  return (
    <div>
      <div className="bg-gray-0 px-5 py-4 dark:bg-dark-7" data-testid="review-gallery">
        <Embla
          key={reviewId}
          align={totalSlides > fits ? 'start' : 'center'}
          withControls={totalSlides > fits}
        >
          <Embla.Viewport>
            <Embla.Container className="-ml-3 flex md:-ml-6">
              {images.map((image, i) => (
                <Embla.Slide key={image.id} index={i} className={SLIDE_CLASS}>
                  {({ inView }) => (
                    <ReviewImage
                      image={image}
                      images={images}
                      reviewId={reviewId}
                      inView={inView}
                    />
                  )}
                </Embla.Slide>
              ))}
              {hasMore && (
                <Embla.Slide className={SLIDE_CLASS}>
                  <Button
                    component={Link}
                    href={viewMoreHref}
                    rel="nofollow"
                    variant="outline"
                    fullWidth
                    radius="md"
                    className="h-full min-h-60"
                  >
                    See all their images →
                  </Button>
                </Embla.Slide>
              )}
            </Embla.Container>
          </Embla.Viewport>
        </Embla>
      </div>
      <div className="flex items-center justify-between gap-3 border-b border-solid border-gray-3 px-5 py-2.5 text-[13px] text-gray-6 dark:border-dark-4 dark:text-dark-2">
        <span className="flex min-w-0 items-center gap-2">
          <IconLibraryPhoto size={14} className="shrink-0" />
          <span className="truncate">
            {postId
              ? postTitle
                ? `From the post “${postTitle}”`
                : 'From the post'
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

function ReviewImage({
  image,
  images,
  reviewId,
  inView,
}: {
  image: ImagesInfiniteModel;
  images: ImagesInfiniteModel[];
  reviewId: number;
  // Off-screen slides keep their size but skip the heavy content.
  inView: boolean;
}) {
  const features = useFeatureFlags();
  // The wrapper takes the image's own shape so `MediaHash` (absolute, inset-0) has a size to fill.
  const ratio = image.width && image.height ? image.width / image.height : 1;
  const size = {
    aspectRatio: ratio,
    width: `min(100%, calc(${MAX_IMAGE_HEIGHT} * ${ratio}))`,
  };

  if (!inView)
    return (
      <div
        className="rounded-md bg-gray-2 dark:bg-dark-9"
        data-testid="review-slide"
        style={size}
      />
    );

  return (
    <ImageGuard2 image={image} connectType="review" connectId={reviewId}>
      {(safe) => (
        <div
          className="relative overflow-hidden rounded-md bg-gray-2 dark:bg-dark-9"
          data-testid="review-slide"
          style={size}
        >
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
                width={800}
                hiDpi={features.hiDpiPreviews}
                sourceWidth={image.width}
                placeholder="empty"
                className="size-full"
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
