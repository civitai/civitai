import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';
import { useQueryImages } from '~/components/Image/image.utils';
import type { ReviewCardProps } from '~/components/ResourceReview/ReviewCard/ReviewCard';
import { ReviewCard } from '~/components/ResourceReview/ReviewCard/ReviewCard';
import { useImageLoadSlot } from '~/components/ResourceReview/ReviewCard/imageLoadLimiter';
import { ImageSort } from '~/server/common/enums';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const IMAGES_PER_CARD = 4;

/**
 * A `full` ReviewCard that loads its own images once it nears the viewport, so a page of twenty
 * cards doesn't fire twenty image queries up front. Same image filters as the review dialog's
 * carousel: the review's post when it has one, else the reviewer's most reacted images of the
 * reviewed version. At most a few cards load at a time, the rest wait their turn.
 */
export function ReviewCardWithImages({
  review,
  ...props
}: Omit<ReviewCardProps, 'variant' | 'images'>) {
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '300px' });

  const filters: GetInfiniteImagesInput = review.postId
    ? {
        postId: review.postId,
        modelVersionId: review.modelVersionId,
        period: MetricTimeframe.AllTime,
        limit: IMAGES_PER_CARD,
      }
    : {
        userId: review.user.id,
        modelVersionId: review.modelVersionId,
        sort: ImageSort.MostReactions,
        period: MetricTimeframe.AllTime,
        limit: IMAGES_PER_CARD,
      };
  const wanted = inView && review.imageCount > 0;
  const { granted, release } = useImageLoadSlot(wanted);
  const { images, isSuccess, isError } = useQueryImages(filters, { enabled: wanted && granted });
  const settled = isSuccess || isError;
  useEffect(() => {
    if (settled) release();
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps -- release only reads a ref

  return (
    <div ref={ref} className="w-full">
      <ReviewCard
        postTitle={images[0]?.postTitle}
        {...props}
        review={review}
        variant="full"
        images={images}
      />
    </div>
  );
}
