import { contentGenerationTour } from '~/utils/tours/content-gen.tour';
import { modelPageTour } from '~/utils/tours/model-page.tour';
import { postGenerationTour } from '~/utils/tours/post-image-gen.tour';

export const tourSteps = {
  'content-generation': contentGenerationTour,
  'post-generation': postGenerationTour,
  'model-page': modelPageTour,
} as const;

export type TourKey = keyof typeof tourSteps;
