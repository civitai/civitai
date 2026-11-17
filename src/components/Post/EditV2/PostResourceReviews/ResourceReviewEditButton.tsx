import { ActionIcon } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconMessageCircle } from '@tabler/icons-react';
import { openResourceReviewStepper } from '~/components/Post/EditV2/PostResourceReviews/openResourceReviewStepper';
import { useStepperImagesGetter } from '~/components/Post/EditV2/PostResourceReviews/useStepperImages';
import { usePostResourceReviews } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

export function ResourceReviewEditButton({
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
  const { canReview, byModelVersionId } = usePostResourceReviews({ postId, ownerId });
  const getImages = useStepperImagesGetter();
  const review = byModelVersionId.get(modelVersionId);
  if (!canReview || !review) return null;

  const hasComment = !!review.reviewDetails?.trim();
  const name = modelName ?? 'this resource';
  return (
    <Tooltip label={hasComment ? 'Edit review' : 'Write a review'}>
      <ActionIcon
        size="input-sm"
        radius="md"
        variant="subtle"
        color={hasComment ? 'success' : 'gray'}
        aria-label={hasComment ? `Edit review of ${name}` : `Write a review of ${name}`}
        onClick={() =>
          openResourceReviewStepper({ postId, ownerId, modelVersionId, images: getImages() })
        }
      >
        <IconMessageCircle size={18} />
      </ActionIcon>
    </Tooltip>
  );
}
