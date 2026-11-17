import { Badge, Card } from '@mantine/core';
import { IconEyeOff, IconLibraryPhoto, IconMessageCircle, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ResourceReviewMenu } from '~/components/ResourceReview/ResourceReviewMenu';
import { ReviewVerdictBadge } from '~/components/ResourceReview/ReviewVerdictBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { REVIEW_IMAGE_COUNT_CAP } from '~/server/schema/resourceReview.schema';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type { ResourceReviewPagedModel } from '~/types/router';

const MAX_FULL_IMAGES = 4;
// The phone strip is three tiles wide: two images and the "+N" tile.
const MAX_PHONE_IMAGES = 2;

export type ReviewCardProps = {
  review: ResourceReviewPagedModel;
  /** `compact` is text-only, for the model page's cards; `full` also shows the review's images. */
  variant: 'compact' | 'full';
  /** The review's images (the set its `imageCount` counts); shown by the `full` variant only. */
  images?: ImagesInfiniteModel[];
  /** How many of the fetched images the viewer's preferences hide, so the strip can say so. */
  hiddenImageCount?: number;
  /** Title of the review's post, shown in the "From the post" link of the `full` variant. */
  postTitle?: string | null;
  /** Name of the reviewed version, shown after the date. */
  versionName?: string | null;
  /** The model owner's id; their own review gets the "Excluded from count" badge. */
  creatorId?: number;
};

// Interactive children sit above the stretched link; everything else lets the click through to it.
const interactive = 'pointer-events-auto';

export function ReviewCard({
  review,
  variant,
  images = [],
  hiddenImageCount = 0,
  postTitle,
  versionName,
  creatorId,
}: ReviewCardProps) {
  const full = variant === 'full';
  const shownImages = full ? images.slice(0, MAX_FULL_IMAGES) : [];
  const moreLabel = (shown: number) =>
    review.imageCount > REVIEW_IMAGE_COUNT_CAP
      ? `${REVIEW_IMAGE_COUNT_CAP}+`
      : `+${review.imageCount - shown}`;
  const someHidden = hiddenImageCount > 0;
  const allHidden = full && someHidden && !images.length && review.imageCount > 0;
  const phoneShown = Math.min(shownImages.length, MAX_PHONE_IMAGES);

  const username = review.user.username ?? 'a user';

  // Squares that shrink to fit the card, capped so one or two images don't stretch.
  const tile =
    'relative aspect-square min-w-0 flex-1 basis-0 overflow-hidden rounded-md max-w-[120px] sm:max-w-[150px]';
  const moreTile = (shown: number, className: string) => (
    <div
      className={clsx(
        'shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-gray-1 px-1 text-center dark:bg-dark-5',
        className
      )}
      data-testid="review-more-images"
    >
      <span className="text-lg font-bold text-black dark:text-white">{moreLabel(shown)}</span>
      <span className="text-xs text-gray-6 dark:text-dark-2">
        {someHidden ? 'some hidden' : 'images'}
      </span>
    </div>
  );

  return (
    <Card
      withBorder
      radius="md"
      p={full ? { base: 14, sm: 20 } : 16}
      className={clsx(
        'relative flex w-full flex-col transition-colors hover:bg-gray-0 dark:hover:bg-dark-5',
        full ? 'gap-3.5' : 'h-full gap-3'
      )}
      data-testid="model-written-review"
    >
      {(review.exclude || creatorId === review.user.id) && (
        <Badge color="red" className="self-start">
          Excluded from count
        </Badge>
      )}

      <div
        className={clsx(
          'pointer-events-none relative z-10 flex items-center justify-between',
          full ? 'gap-3' : 'gap-2.5'
        )}
      >
        <div className={clsx(interactive, 'min-w-0')}>
          <UserAvatar
            user={review.user}
            subText={
              <>
                <DaysFromNow date={review.createdAt} />
                {versionName ? ` · ${versionName}` : null}
              </>
            }
            subTextForce
            size="sm"
            avatarSize={32}
            spacing="xs"
            withUsername
            linkToProfile
          />
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ReviewVerdictBadge
            recommended={review.recommended}
            variant={full ? 'responsive' : 'icon'}
          />
          {full && (
            <div className={interactive}>
              <ResourceReviewMenu
                reviewId={review.id}
                userId={review.user.id}
                review={{ ...review, details: review.details ?? '' }}
              />
            </div>
          )}
        </div>
      </div>

      {review.details && (
        <div
          className={clsx(
            'text-dark-9 dark:text-dark-0',
            full
              ? 'text-sm leading-[22px] sm:text-[15px] sm:leading-[23px]'
              : 'line-clamp-5 text-[13px] leading-5'
          )}
        >
          {full ? (
            <ContentClamp maxHeight={300}>
              <RenderHtml html={review.details} withProfanityFilter />
            </ContentClamp>
          ) : (
            <RenderHtml html={review.details} withProfanityFilter />
          )}
        </div>
      )}

      {/* Pushes the footer to the card's bottom edge when sibling cards in the row are taller. */}
      {!full && <div className="flex-1" />}

      {allHidden && (
        <div
          className="flex h-[120px] flex-col items-center justify-center gap-1 rounded-md bg-gray-1 px-2 text-center text-xs text-gray-6 sm:h-[150px] dark:bg-dark-5 dark:text-dark-2"
          data-testid="review-images-hidden"
        >
          <IconEyeOff size={20} />
          Hidden by your preferences
        </div>
      )}

      {shownImages.length > 0 && (
        <div className="flex gap-2" data-testid="review-images">
          {shownImages.map((image, index) => (
            // The tile wraps ImageGuard2 so its blur sits inside the tile; the tile is too small for
            // the "This image is rated" explanation, and the eye toggle is enough here.
            <div
              key={image.id}
              className={clsx(tile, index >= MAX_PHONE_IMAGES && 'hidden sm:block')}
            >
              <ImageGuard2 image={image} connectType="review" connectId={review.id} explain={false}>
                {(safe) => (
                  <>
                    <ImageGuard2.BlurToggle
                      className={clsx('absolute left-2 top-2 z-10', interactive)}
                    />
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
                  </>
                )}
              </ImageGuard2>
            </div>
          ))}
          {review.imageCount > phoneShown &&
            moreTile(phoneShown, 'flex w-[72px] self-stretch sm:hidden')}
          {review.imageCount > shownImages.length &&
            moreTile(shownImages.length, 'hidden w-24 self-stretch sm:flex')}
        </div>
      )}

      <div
        className={clsx(
          'pointer-events-none relative z-10 flex items-center text-dark-2',
          full ? 'gap-4 text-[13px]' : 'gap-1.5 text-xs'
        )}
      >
        {review.postId ? (
          full ? (
            <Link
              href={`/posts/${review.postId}`}
              className={clsx(
                'flex min-w-0 items-center gap-1.5 truncate text-blue-6 dark:text-blue-4',
                interactive
              )}
            >
              <IconLibraryPhoto size={14} className="shrink-0" />
              <span className="truncate">
                {postTitle ? `From the post “${postTitle}”` : 'From the post'}
              </span>
            </Link>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <IconLibraryPhoto size={13} className="shrink-0" />
              From a post
            </span>
          )
        ) : null}
        <span className="flex-1" />
        {!full && review.imageCount > 0 && (
          <span className="flex shrink-0 items-center gap-1.5" aria-label="Images">
            <IconPhoto size={13} />
            {review.imageCount > REVIEW_IMAGE_COUNT_CAP
              ? `${REVIEW_IMAGE_COUNT_CAP}+`
              : review.imageCount}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5" aria-label="Comments">
          <IconMessageCircle size={full ? 14 : 13} />
          {full
            ? `${review.commentCount ?? 0} ${review.commentCount === 1 ? 'comment' : 'comments'}`
            : review.commentCount ?? 0}
        </span>
      </div>
      <RoutedDialogLink
        name="resourceReview"
        state={{ reviewId: review.id }}
        rel="nofollow"
        className="absolute inset-0 rounded-md outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-6"
      >
        <span className="sr-only">Read review by {username}</span>
      </RoutedDialogLink>
    </Card>
  );
}
