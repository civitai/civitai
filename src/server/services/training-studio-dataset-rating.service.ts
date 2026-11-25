import type { StudioDatasetRatingInput } from '~/server/schema/training-studio-dataset-rating.schema';
import { isRateableMediaUrl, rateImagesV2 } from '~/server/services/rating-v2.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { usageLimits } from '~/shared/constants/usage-limits';

/** Per-minute and per-day images, counted per request (one image each) in the `training:` bucket. */
export const STUDIO_DATASET_RATING_RATE_LIMIT = {
  key: 'training:studioDatasetRating',
  rules: usageLimits('dataset-rating.submit', 'dataset-rating.daily'),
};
/** Across all users, per fixed 24h window: bounds the system-paid GPU spend, and with it the Studio's
 *  live sent markers in the system Redis. */
export const STUDIO_DATASET_RATING_GLOBAL_LIMIT = {
  key: 'training-studio:dataset-rating:global',
  max: 50_000,
  windowSeconds: 24 * 60 * 60,
};
export async function rateStudioDatasetImages({
  userId,
  matureLevel,
  items,
}: Pick<StudioDatasetRatingInput, 'items'> & { userId: number; matureLevel: number }): Promise<{
  results: { key: string; mature: boolean | null }[];
}> {
  if (!items.every((i) => isRateableMediaUrl(i.mediaUrl)))
    throw throwBadRequestError('Dataset rating only accepts images uploaded to Civitai.');
  // Only the mature bit leaves the main app: the level and the restricted flag are classifier detail
  // the Studio does not need.
  const results = await rateImagesV2({
    items,
    matureLevel,
    metadata: { kind: 'studio-dataset-rating', userId },
    tags: ['civitai', 'training-studio', 'dataset-rating'],
  });
  return { results };
}
