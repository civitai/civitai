import { useInView } from 'react-intersection-observer';
import { useQueryImages } from '~/components/Image/image.utils';
import type { ReviewCardProps } from '~/components/ResourceReview/ReviewCard/ReviewCard';
import { ReviewCard } from '~/components/ResourceReview/ReviewCard/ReviewCard';
import { ImageSort } from '~/server/common/enums';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const IMAGES_PER_CARD = 4;

/**
 * A `full` ReviewCard that loads its own images once it nears the viewport, so a page of twenty
 * cards doesn't fire twenty image queries up front. Same image filters as the review dialog's
 * carousel: the review's post when it has one, else the reviewer's most reacted images of the
 * reviewed version.
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
  const { images } = useQueryImages(filters, { enabled: inView && review.imageCount > 0 });

  return (
    <div ref={ref} className="w-full">
      <ReviewCard {...props} review={review} variant="full" images={images} />
    </div>
  );
}
