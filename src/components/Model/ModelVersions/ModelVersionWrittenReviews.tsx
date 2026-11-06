import { Button, Paper, ThemeIcon, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { getModelReviewsCanonical } from '~/components/ResourceReview/model-reviews-url';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

const REVIEW_COUNT = 4;

export function ModelVersionWrittenReviews({
  modelId,
  modelVersionId,
}: {
  modelId: number;
  modelVersionId: number;
}) {
  const { modelPageReviews } = useFeatureFlags();
  const { data } = trpc.resourceReview.getPaged.useQuery(
    { modelId, modelVersionId, limit: REVIEW_COUNT, page: 1, writtenOnly: true },
    { enabled: !!modelPageReviews }
  );

  const reviews = data?.items ?? [];
  if (!modelPageReviews || !reviews.length) return null;

  return (
    <section className="flex flex-col gap-4" data-testid="model-written-reviews">
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
      <div className="-mx-4 flex snap-x scroll-px-4 gap-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
        {reviews.map((review) => (
          <Paper
            key={review.id}
            withBorder
            radius="md"
            p="md"
            className="flex w-[80%] shrink-0 snap-start flex-col gap-3 sm:w-[45%] lg:w-auto"
            data-testid="model-written-review"
          >
            <div className="flex items-start justify-between gap-2">
              <UserAvatar
                user={review.user}
                subText={<DaysFromNow date={review.createdAt} />}
                subTextForce
                withUsername
                linkToProfile
              />
              <ThemeIcon
                color={review.recommended ? 'success.5' : 'red'}
                variant="light"
                radius="md"
                aria-label={review.recommended ? 'Recommended' : 'Not recommended'}
              >
                {review.recommended ? <ThumbsUpIcon filled /> : <ThumbsDownIcon filled />}
              </ThemeIcon>
            </div>
            <div className="line-clamp-5 text-sm">
              <RenderHtml html={review.details ?? ''} withProfanityFilter />
            </div>
            <RoutedDialogLink
              name="resourceReview"
              state={{ reviewId: review.id }}
              rel="nofollow"
              className="mt-auto text-sm"
            >
              Read review
            </RoutedDialogLink>
          </Paper>
        ))}
      </div>
    </section>
  );
}
