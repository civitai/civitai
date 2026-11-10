import { ActionIcon, Group, Text } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { usePostResourceReviews } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';

export function ResourceReviewThumbs({
  postId,
  ownerId,
  modelVersionId,
  modelName,
}: {
  postId: number;
  ownerId: number;
  modelVersionId: number;
  modelName?: string | null;
}) {
  const { canReview, byModelVersionId, isPending, rate } = usePostResourceReviews({
    postId,
    ownerId,
  });
  const review = byModelVersionId.get(modelVersionId);
  if (!canReview || !review) return null;

  const recommended = review.reviewRecommended;
  const disabled = isPending(modelVersionId);
  const name = modelName ?? 'this resource';
  const size = 'input-sm';

  return (
    <Group gap={4} wrap="nowrap" data-tour="post:rate-resource">
      <Tooltip label={recommended === true ? 'Recommended' : 'Recommend'}>
        <ActionIcon
          size={size}
          radius="md"
          variant={recommended === true ? 'light' : 'subtle'}
          color={recommended === true ? 'success' : 'gray'}
          aria-label={`Recommend ${name}`}
          aria-pressed={recommended === true}
          disabled={disabled}
          onClick={() => (recommended !== true ? rate(modelVersionId, true) : undefined)}
        >
          <ThumbsUpIcon size={18} filled={recommended === true} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Not for me">
        <ActionIcon
          size={size}
          radius="md"
          variant={recommended === false ? 'light' : 'subtle'}
          color={recommended === false ? 'red' : 'gray'}
          aria-label={`Not for me: ${name}`}
          aria-pressed={recommended === false}
          disabled={disabled}
          onClick={() => (recommended !== false ? rate(modelVersionId, false) : undefined)}
        >
          <ThumbsDownIcon size={18} filled={recommended === false} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/** Small hint for the row's version line when the owner's review has a comment. */
export function ResourceReviewCommentHint({
  postId,
  ownerId,
  modelVersionId,
}: {
  postId: number;
  ownerId: number;
  modelVersionId: number;
}) {
  const { canReview, byModelVersionId } = usePostResourceReviews({ postId, ownerId });
  const details = byModelVersionId.get(modelVersionId)?.reviewDetails;
  if (!canReview || !details?.trim()) return null;
  return (
    <Text span size="xs" c="success.5">
      {' · '}reviewed with a comment
    </Text>
  );
}
