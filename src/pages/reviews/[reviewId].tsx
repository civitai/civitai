import { useRouter } from 'next/router';
import { ResourceReviewDetail } from '~/components/ResourceReview/ResourceReviewDetail';

export default function ReviewDetailPage() {
  const router = useRouter();
  const reviewId = Number(router.query.reviewId);

  return <ResourceReviewDetail reviewId={reviewId} />;
}
