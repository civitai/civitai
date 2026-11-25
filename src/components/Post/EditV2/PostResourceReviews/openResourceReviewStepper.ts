import { openDialog } from '~/components/Dialog/openDialog';
import type { ResourceReviewStepperProps } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewStepper';

/** Opens the review stepper at `modelVersionId`, or at the first unrated resource when omitted. */
export function openResourceReviewStepper(props: ResourceReviewStepperProps) {
  openDialog(
    () => import('~/components/Post/EditV2/PostResourceReviews/ResourceReviewStepper'),
    'ResourceReviewStepper',
    props
  );
}
