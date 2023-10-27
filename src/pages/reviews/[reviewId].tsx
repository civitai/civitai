import { useRouter } from 'next/router';
import { ResourceReviewDetail } from '~/components/ResourceReview/ResourceReviewDetail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export default function ReviewDetailPage() {
  const router = useRouter();
  const reviewId = Number(router.query.reviewId);

  return <ResourceReviewDetail reviewId={reviewId} />;
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { reviewId: string };
    const id = Number(params.reviewId);
    if (!isNumber(id)) return { notFound: true };

    await ssg?.resourceReview.get.prefetch({ id });
  },
});
