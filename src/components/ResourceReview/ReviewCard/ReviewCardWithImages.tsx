import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';
import type { ReviewCardProps } from '~/components/ResourceReview/ReviewCard/ReviewCard';
import { ReviewCard } from '~/components/ResourceReview/ReviewCard/ReviewCard';
import { useImageLoadSlot } from '~/components/ResourceReview/ReviewCard/imageLoadLimiter';
import { useReviewImages } from '~/components/ResourceReview/useReviewImages';

// Matches the review dialog's request (its eight tiles plus one), so opening it reuses this query.
const IMAGES_FETCHED = 9;

/**
 * A `full` ReviewCard that loads its own images once near the viewport, so a page of cards doesn't
 * fire an image query per card up front.
 */
export function ReviewCardWithImages({
  review,
  ...props
}: Omit<ReviewCardProps, 'variant' | 'images'>) {
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '300px' });

  const wanted = inView && review.imageCount > 0;
  const { granted, release } = useImageLoadSlot(wanted);
  const { images, flatData, isLoading, isSuccess, isError } = useReviewImages(
    { reviewId: review.id, limit: IMAGES_FETCHED },
    { enabled: wanted && granted }
  );
  const settled = isSuccess || isError;
  useEffect(() => {
    if (settled) release();
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps -- release only reads a ref

  return (
    <div ref={ref} className="w-full">
      <ReviewCard
        {...props}
        review={review}
        variant="full"
        images={images}
        // Until the viewer's preferences load, `images` is empty and every row would read as hidden.
        hiddenImageCount={isLoading ? 0 : flatData.length - images.length}
      />
    </div>
  );
}
