import { Button, Loader, Text } from '@mantine/core';
import { IconInfoCircle, IconLibraryPhoto, IconPhotoOff } from '@tabler/icons-react';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  ExplainHiddenImages,
  useExplainHiddenImages,
} from '~/components/Image/ExplainHiddenImages/ExplainHiddenImages';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Reactions } from '~/components/Reaction/Reactions';
import { useReviewImages } from '~/components/ResourceReview/useReviewImages';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { useEmblaStore } from '~/components/EmblaCarousel/EmblaCarouselProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import classes from './ResourceReviewCarousel.module.css';

const MAX_IMAGES = 8;
const MOBILE_MAX_IMAGE_HEIGHT = '60vh';
// Desktop slides share one height and take their width from the image, so as many as fit show.
const DESKTOP_IMAGE_HEIGHT = '55vh';
const SIDE_SLIDE_WIDTH = 240;
const SLIDE_CLASS =
  'flex max-w-full flex-[0_0_100%] items-center justify-center pl-2 md:flex-none md:justify-start';

/**
 * The review dialog's gallery: up to eight of the images its `imageCount` counts, each shown whole,
 * with a slide explaining any the viewer's preferences hide and a final slide linking to the rest.
 */
export function ResourceReviewCarousel(props: CarouselProps) {
  // Its own providers, so "Show Hidden" raises the level only for this gallery's query.
  return (
    <BrowsingLevelProvider>
      <BrowsingSettingsAddonsProvider>
        <ReviewGallery {...props} />
      </BrowsingSettingsAddonsProvider>
    </BrowsingLevelProvider>
  );
}

type CarouselProps = {
  userId: number;
  modelVersionId: number;
  reviewId: number;
  postId: number | null;
};

function ReviewGallery({ userId, modelVersionId, reviewId, postId }: CarouselProps) {
  const mobile = !!useIsMobile({ type: 'media' });
  const {
    images: fetched,
    flatData,
    isLoading,
    isError,
    refetch,
  } = useReviewImages({ reviewId, limit: MAX_IMAGES + 1 });
  const images = fetched.slice(0, MAX_IMAGES);
  const hiddenExplained = useExplainHiddenImages(flatData);

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
  if (!images.length && !hiddenExplained.hasHidden) return <NoReviewImages />;

  const hasMore = fetched.length > MAX_IMAGES;
  const viewMoreHref = postId
    ? `/posts/${postId}`
    : `/images?view=feed&periodMode=stats&modelVersionId=${modelVersionId}&userId=${userId}`;

  return (
    <div>
      <div className="bg-gray-0 px-5 py-4 dark:bg-dark-7" data-testid="review-gallery">
        <Embla key={reviewId} align="start" slidesToScroll="auto">
          <Embla.Viewport>
            <Embla.Container className="-ml-2 flex">
              {images.map((image, i) => (
                <Embla.Slide key={image.id} index={i} className={SLIDE_CLASS}>
                  {({ inView }) => (
                    <ReviewImage
                      image={image}
                      images={images}
                      reviewId={reviewId}
                      inView={inView}
                      mobile={mobile}
                    />
                  )}
                </Embla.Slide>
              ))}
              {hiddenExplained.hasHidden && (
                <Embla.Slide className={SLIDE_CLASS}>
                  <div
                    className="flex size-full min-h-60 items-center justify-center rounded-md bg-gray-2 p-4 dark:bg-dark-9"
                    style={sideSlideStyle(mobile)}
                    data-testid="review-hidden-explain"
                  >
                    <ExplainHiddenImages {...hiddenExplained} />
                  </div>
                </Embla.Slide>
              )}
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
                    style={sideSlideStyle(mobile)}
                  >
                    See all their images →
                  </Button>
                </Embla.Slide>
              )}
            </Embla.Container>
          </Embla.Viewport>
          <OverflowControls />
        </Embla>
      </div>
      <div className="flex items-center justify-between gap-3 border-b border-solid border-gray-3 px-5 py-2.5 text-[13px] text-gray-6 dark:border-dark-4 dark:text-dark-2">
        <span className="flex min-w-0 items-center gap-2">
          <IconLibraryPhoto size={14} className="shrink-0" />
          <span className="truncate">
            {postId ? 'From the post' : 'Images made with this version'}
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

function sideSlideStyle(mobile: boolean) {
  return mobile ? undefined : { height: DESKTOP_IMAGE_HEIGHT, width: SIDE_SLIDE_WIDTH };
}

function OverflowControls() {
  const overflows = useEmblaStore((state) => state.canScrollNext || state.canScrollPrev);
  return overflows ? <Embla.Controls /> : null;
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
  mobile,
}: {
  image: ImagesInfiniteModel;
  images: ImagesInfiniteModel[];
  reviewId: number;
  inView: boolean;
  mobile: boolean;
}) {
  const features = useFeatureFlags();
  // The wrapper takes the image's own shape so `MediaHash` (absolute, inset-0) has a size to fill.
  const ratio = image.width && image.height ? image.width / image.height : 1;
  const size = mobile
    ? { aspectRatio: ratio, width: `min(100%, calc(${MOBILE_MAX_IMAGE_HEIGHT} * ${ratio}))` }
    : { aspectRatio: ratio, height: DESKTOP_IMAGE_HEIGHT, maxWidth: '100%' };

  if (!inView)
    return (
      <div
        className="rounded-md bg-gray-2 dark:bg-dark-9"
        data-testid="review-slide"
        style={size}
      />
    );

  return (
    // ImageGuard2 renders its "This image is rated" overlay beside its children, so the positioned
    // slide has to wrap it, or the overlay centers on whatever positioned ancestor comes next.
    <div
      className="relative overflow-hidden rounded-md bg-gray-2 dark:bg-dark-9"
      data-testid="review-slide"
      style={size}
    >
      <ImageGuard2 image={image} connectType="review" connectId={reviewId}>
        {(safe) => (
          <>
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
          </>
        )}
      </ImageGuard2>
    </div>
  );
}
