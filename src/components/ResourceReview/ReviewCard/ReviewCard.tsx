import { Badge, Card, ThemeIcon } from '@mantine/core';
import { IconMessage, IconPhoto } from '@tabler/icons-react';
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
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { REVIEW_IMAGE_COUNT_CAP } from '~/server/schema/resourceReview.schema';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import type { ResourceReviewPagedModel } from '~/types/router';

const MAX_FULL_IMAGES = 4;

export type ReviewCardProps = {
  review: ResourceReviewPagedModel;
  /** `compact` is ~270px wide for the model page; `full` fills its column and shows the review's images. */
  variant: 'compact' | 'full';
  /** The review's post images, shown by the `full` variant only. */
  images?: ImagesInfiniteModel[];
  /** Title of the review's post, shown in the "From the post" link of the `full` variant. */
  postTitle?: string | null;
  /** The model owner's id: their own review is excluded from the count. */
  creatorId?: number;
};

export function ReviewCard({
  review,
  variant,
  images = [],
  postTitle,
  creatorId,
}: ReviewCardProps) {
  const full = variant === 'full';
  const shownImages = full ? images.slice(0, MAX_FULL_IMAGES) : [];
  const imageCount =
    review.imageCount > REVIEW_IMAGE_COUNT_CAP ? `${REVIEW_IMAGE_COUNT_CAP}+` : review.imageCount;
  const isShort = !review.details && !review.imageCount && !images.length;

  const username = review.user.username ?? 'a user';
  const thumb = (
    <ThemeIcon
      color={review.recommended ? 'success.5' : 'red'}
      variant="light"
      radius="md"
      aria-label={review.recommended ? 'Recommended' : 'Not recommended'}
    >
      {review.recommended ? <ThumbsUpIcon filled /> : <ThumbsDownIcon filled />}
    </ThemeIcon>
  );

  return (
    <Card
      withBorder
      radius="md"
      p={isShort ? 'sm' : 'md'}
      className={clsx(
        'relative flex w-full flex-col gap-3 transition-colors hover:bg-gray-0 dark:hover:bg-dark-5',
        isShort && 'flex-row items-center'
      )}
      data-testid="model-written-review"
    >
      {!isShort && (review.exclude || creatorId === review.user.id) && (
        <Badge color="red" className="self-start">
          Excluded from count
        </Badge>
      )}

      <div
        className={clsx(
          'relative z-10 flex items-start justify-between gap-2',
          isShort && 'flex-1'
        )}
      >
        <UserAvatar
          user={review.user}
          subText={<DaysFromNow date={review.createdAt} />}
          subTextForce
          withUsername
          linkToProfile
        />
        <div className="flex items-center gap-1">
          {thumb}
          {full && !isShort && (
            <ResourceReviewMenu
              reviewId={review.id}
              userId={review.user.id}
              review={{ ...review, details: review.details ?? '' }}
            />
          )}
        </div>
      </div>

      {review.details && (
        <div className={clsx('text-sm', !full && 'line-clamp-5')}>
          {full ? (
            <ContentClamp maxHeight={300}>
              <RenderHtml html={review.details} withProfanityFilter />
            </ContentClamp>
          ) : (
            <RenderHtml html={review.details} withProfanityFilter />
          )}
        </div>
      )}

      {shownImages.length > 0 && (
        <div className="flex gap-2">
          {shownImages.map((image) => (
            <ImageGuard2 key={image.id} image={image} connectType="review" connectId={review.id}>
              {(safe) => (
                <div className="relative h-36 min-w-0 flex-1 overflow-hidden rounded-md">
                  <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
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
                </div>
              )}
            </ImageGuard2>
          ))}
        </div>
      )}

      {!isShort && (
        <div className="relative z-10 flex items-center gap-3 text-sm text-gray-6 dark:text-dark-2">
          {full && review.postId ? (
            <Link href={`/posts/${review.postId}`} className="min-w-0 flex-1 truncate">
              {postTitle ? `From the post “${postTitle}”` : 'From the post'}
            </Link>
          ) : (
            <span className="flex-1" />
          )}
          {review.imageCount > 0 && (
            <Badge px={4} leftSection={<IconPhoto size={14} />} aria-label={`${imageCount} images`}>
              {imageCount}
            </Badge>
          )}
          <Badge px={4} leftSection={<IconMessage size={14} />} aria-label="Comments">
            {review.commentCount ?? 0}
          </Badge>
        </div>
      )}

      {/* An empty link stretched over the whole card, so the card is the click target and keyboard stop. Interactive children sit above it (`z-10`) so they don't double-fire. */}
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
