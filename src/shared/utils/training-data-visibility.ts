import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';

/** A training dataset is public only when its owner holds the rights and chose to share it. */
export function trainingDataVisibility({
  ownRights,
  shareDataset,
}: {
  ownRights: boolean;
  shareDataset: boolean;
}): ModelFileVisibility {
  if (ownRights && shareDataset) return ModelFileVisibility.Public;
  return ownRights ? ModelFileVisibility.Sensitive : ModelFileVisibility.Private;
}

/**
 * Whether a host may serve a `Training Data` file, from the rating its metadata records:
 * `nsfwLevel` (the bitwise rating of the zip's rated items) and `fullyRated` (whether every item
 * was rated).
 */
export function trainingDataServableOnHost(
  metadata: { nsfwLevel?: unknown; fullyRated?: unknown } | null | undefined,
  redCapable: boolean
): boolean {
  if (redCapable) return true;
  if (metadata?.fullyRated === false) return false;
  const level = metadata?.nsfwLevel;
  return typeof level !== 'number' || (level & ~sfwBrowsingLevelsFlag) === 0;
}
