import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';

export type RatedEntry = { mediaType?: string | null; nsfwLevel?: string | null };

/**
 * A Training Data zip's rating from its entries: the OR of each media entry's level, and
 * `fullyRated` only when there is media and every media entry has a level
 * (trainingDataServableOnHost reads both). Caption entries carry no level and are not counted.
 */
export function datasetRating(entries: RatedEntry[]): {
  nsfwLevel: number | undefined;
  fullyRated: boolean;
} {
  let nsfwLevel = 0;
  let media = 0;
  let unrated = 0;
  for (const entry of entries) {
    if (entry.mediaType === 'text') continue;
    media += 1;
    const level = entry.nsfwLevel ? orchestratorNsfwLevelMap[entry.nsfwLevel.toLowerCase()] : 0;
    if (level) nsfwLevel |= level;
    else unrated += 1;
  }
  return { nsfwLevel: nsfwLevel || undefined, fullyRated: media > 0 && unrated === 0 };
}
