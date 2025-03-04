import { auctionTour } from '~/components/Tours/tours/auction.tour';
import {
  contentGenerationTour,
  remixContentGenerationTour,
} from '~/components/Tours/tours/content-gen.tour';
import { modelPageTour, welcomeTour } from '~/components/Tours/tours/model-page.tour';
import { postGenerationTour } from '~/components/Tours/tours/post-image-gen.tour';

export const tourSteps = {
  'content-generation': contentGenerationTour,
  'remix-content-generation': remixContentGenerationTour,
  'post-generation': postGenerationTour,
  'model-page': modelPageTour,
  auction: auctionTour,
  welcome: welcomeTour,
} as const;

export type TourKey = keyof typeof tourSteps;
