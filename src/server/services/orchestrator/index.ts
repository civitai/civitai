import { formatTextToImageResponses } from '~/server/services/orchestrator/textToImage';

export type NormalizedTextToImageResponse = AsyncReturnType<
  typeof formatTextToImageResponses
>[number];
export type NormalizedTextToImageParams = NormalizedTextToImageResponse['params'];
export type NormalizedTextToImageResource = NormalizedTextToImageResponse['resources'][number];
export type NormalizedTextToImageImage = NormalizedTextToImageResponse['images'][number];
