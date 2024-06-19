import { formatTextToImageResponses } from '~/server/services/orchestrator/textToImage';

export type NormalizedTextToImageResponse = AsyncReturnType<
  typeof formatTextToImageResponses
>[number];
export type NormalizedTextToImageStep = NormalizedTextToImageResponse['steps'][number];
export type NormalizedTextToImageParams = NormalizedTextToImageStep['params'];
export type NormalizedTextToImageResource = NormalizedTextToImageStep['resources'][number];
export type NormalizedTextToImageImage = NormalizedTextToImageStep['images'][number];
