import { Button, Container, Text, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { getModelReviewsCanonical } from '~/components/ResourceReview/model-reviews-url';
import { ReviewCard } from '~/components/ResourceReview/ReviewCard/ReviewCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getRatingSummary } from '~/utils/rating-label';
import { trpc } from '~/utils/trpc';

const REVIEW_COUNT = 4;

export function ModelVersionWrittenReviews({
  modelId,
  modelVersionId,
  thumbsUpCount = 0,
  thumbsDownCount = 0,
}: {
  modelId: number;
  modelVersionId: number;
  /** The model's all-time counts (every version, written or not): the same numbers the page's thumbs badge and star rating read. */
  thumbsUpCount?: number;
  thumbsDownCount?: number;
}) {
  const { modelPageReviews } = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();
  const { data } = trpc.resourceReview.getPaged.useQuery(
    { modelId, modelVersionId, limit: REVIEW_COUNT, page: 1, writtenOnly: true, browsingLevel },
    { enabled: !!modelPageReviews }
  );

  const reviews = data?.items ?? [];
  if (!modelPageReviews || !reviews.length) return null;

  const rating = getRatingSummary({ thumbsUp: thumbsUpCount, thumbsDown: thumbsDownCount });

  return (
    <Container size="xl" mt="xl">
      <section className="flex flex-col gap-4" data-testid="model-written-reviews">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <Title order={2}>Reviews</Title>
            <Button
              component={Link}
              href={getModelReviewsCanonical(modelId, modelVersionId)}
              variant="outline"
              size="xs"
              rightSection={<IconArrowRight size={16} />}
            >
              See all reviews
            </Button>
          </div>
          {rating && (
            <Text size="sm" c="dimmed" data-testid="model-written-reviews-summary">
              <Text component="span" fw={600} c={rating.color} tt="capitalize">
                {rating.label}
              </Text>{' '}
              · {rating.percent}% of {rating.total.toLocaleString()}{' '}
              {rating.total === 1 ? 'review' : 'reviews'}
            </Text>
          )}
        </div>
        <div className="-mx-4 flex snap-x scroll-px-4 gap-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
          {reviews.map((review) => (
            <div key={review.id} className="flex w-4/5 shrink-0 snap-start sm:w-[45%] lg:w-auto">
              <ReviewCard review={review} variant="compact" />
            </div>
          ))}
        </div>
      </section>
    </Container>
  );
}
