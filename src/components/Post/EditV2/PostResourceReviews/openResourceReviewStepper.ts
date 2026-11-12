import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceReviewStepperProps } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewStepper';

const ResourceReviewStepper = dynamic(
  () =>
    import('~/components/Post/EditV2/PostResourceReviews/ResourceReviewStepper').then(
      (m) => m.ResourceReviewStepper
    ),
  { ssr: false }
);

/** Opens the review stepper at `modelVersionId`, or at the first unrated resource when omitted. */
export function openResourceReviewStepper(props: ResourceReviewStepperProps) {
  dialogStore.trigger({ component: ResourceReviewStepper, props });
}
