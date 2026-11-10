import { ActionIcon } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';
import { openResourceReviewStepper } from '~/components/Post/EditV2/PostResourceReviews/openResourceReviewStepper';
import type { StepperImage } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewStepper';
import { usePostResourceReviews } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

export function ResourceReviewEditButton({
  postId,
  ownerId,
  modelVersionId,
  modelName,
  getImages,
}: {
  postId: number;
  ownerId: number;
  modelVersionId: number;
  modelName?: string | null;
  /** Read on click, so the row does not re-render with every image edit. */
  getImages: () => StepperImage[];
}) {
  const { canReview, byModelVersionId } = usePostResourceReviews({ postId, ownerId });
  const review = byModelVersionId.get(modelVersionId);
  if (!canReview || !review) return null;

  const hasComment = !!review.reviewDetails?.trim();
  const name = modelName ?? 'this resource';
  return (
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
      <IconPencil size={18} />
    </ActionIcon>
  );
}
