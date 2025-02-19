import { contentGenerationTour, remixContentGenerationTour } from '~/utils/tours/content-gen.tour';
import { modelPageTour, welcomeTour } from '~/utils/tours/model-page.tour';
import { postGenerationTour } from '~/utils/tours/post-image-gen.tour';

export const tourSteps = {
  'content-generation': contentGenerationTour,
  'remix-content-generation': remixContentGenerationTour,
  'post-generation': postGenerationTour,
  'model-page': modelPageTour,
  welcome: welcomeTour,
} as const;

export type TourKey = keyof typeof tourSteps;
