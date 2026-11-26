import { useCallback, useRef } from 'react';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import type { StepperImage } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewStepper';

type StoreImage = {
  type: string;
  data: {
    id: number;
    url: string;
    type: string;
    index?: number | null;
    resourceHelper: { modelVersionId?: number | null }[];
  };
};

/** Every added image of the post, in display order, in the shape the stepper dialog renders. */
export function toStepperImages(storeImages: StoreImage[]): StepperImage[] {
  return storeImages
    .flatMap((x) => (x.type === 'added' ? [x.data] : []))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((image) => ({
      id: image.id,
      url: image.url,
      type: image.type,
      modelVersionIds: image.resourceHelper.flatMap((r) =>
        r.modelVersionId ? [r.modelVersionId] : []
      ),
    }));
}

/** The snapshot is built on click from the latest store images, so every entry point agrees. */
export function useStepperImagesGetter() {
  const storeImages = usePostEditStore((state) => state.images);
  const latest = useRef(storeImages);
  latest.current = storeImages;
  return useCallback(() => toStepperImages(latest.current as StoreImage[]), []);
}
