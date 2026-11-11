import { Alert, Anchor, Group, Paper, Progress, Stack, Text } from '@mantine/core';
import { IconLock, IconThumbUp } from '@tabler/icons-react';
import { useMemo } from 'react';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { openResourceReviewStepper } from '~/components/Post/EditV2/PostResourceReviews/openResourceReviewStepper';
import { focusReviewTarget } from '~/components/Post/EditV2/PostResourceReviews/reviewFocus';
import { useStepperImagesGetter } from '~/components/Post/EditV2/PostResourceReviews/useStepperImages';
import { usePostResourceReviews } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

export function ResourceReviewProgressCard({
  postId,
  ownerId,
}: {
  postId: number;
  ownerId: number;
}) {
  const { reviews, counts, canReview, isMuted, isOwner } = usePostResourceReviews({
    postId,
    ownerId,
  });
  const getImages = useStepperImagesGetter();
  const storeImages = usePostEditStore((state) => state.images);
  const images = useMemo(
    () =>
      storeImages
        .flatMap((x) => (x.type === 'added' ? [x.data] : []))
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
    [storeImages]
  );

  if (isMuted && isOwner) {
    // Muted users never load reviews, so the images decide whether there is anything to review.
    const hasResources = images.some((x) => x.resourceHelper.some((r) => !!r.modelName));
    return hasResources ? (
      <Alert color="yellow" icon={<IconLock />}>
        You cannot add reviews because you have been muted
      </Alert>
    ) : null;
  }
  if (!canReview || counts.total === 0) return null;

  const allRated = counts.rated === counts.total;
  const open = (modelVersionId?: number) =>
    openResourceReviewStepper({
      postId,
      ownerId,
      modelVersionId,
      images: getImages(),
    });

  const goToNextUnrated = () => {
    const unrated = new Set(
      reviews.filter((r) => r.reviewRecommended == null).map((r) => r.modelVersionId)
    );
    for (const image of images) {
      const resource = image.resourceHelper.find(
        (r) => !!r.modelName && unrated.has(r.modelVersionId)
      );
      if (resource)
        return focusReviewTarget({ imageId: image.id, modelVersionId: resource.modelVersionId });
    }
  };

  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap={8}>
        <Group gap={6} wrap="nowrap">
          <Text c="success.5" inline>
            <IconThumbUp size={18} />
          </Text>
          <Text size="sm" fw={600} c={allRated ? 'success.5' : undefined}>
            {allRated
              ? 'All resources rated'
              : `${counts.rated} of ${counts.total} resources rated`}
          </Text>
        </Group>
        <Progress
          value={(counts.rated / counts.total) * 100}
          size={4}
          color="success"
          aria-label="Resources rated"
        />
        <Group gap="md">
          <Anchor
            component="button"
            type="button"
            size="xs"
            onClick={() => open(allRated ? reviews[0]?.modelVersionId ?? undefined : undefined)}
          >
            {allRated ? 'Edit reviews' : 'Review the rest'} →
          </Anchor>
          {!allRated && (
            <Anchor component="button" type="button" size="xs" onClick={goToNextUnrated}>
              Next unrated ↓
            </Anchor>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}
