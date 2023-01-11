import { ImageAnalysisInput } from '~/server/schema/image.schema';

export function detectNsfwImage({ porn, hentai, sexy }: ImageAnalysisInput) {
  // If the sum of sketchy probabilities is greater than 0.5, it's NSFW
  const isNSFW = porn + hentai + sexy * 0.5 > 0.5;
  return isNSFW;
}
