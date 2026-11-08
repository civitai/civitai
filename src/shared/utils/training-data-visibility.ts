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
 * Whether a host may serve a `Training Data` file rated `nsfwLevel` (its metadata key, the
 * bitwise rating of the zip's rated items). Only a red-capable host serves a dataset rated above
 * PG-13; one with no rating is served on any host.
 */
export function trainingDataServableOnHost(nsfwLevel: unknown, redCapable: boolean): boolean {
  if (redCapable || typeof nsfwLevel !== 'number') return true;
  return (nsfwLevel & ~sfwBrowsingLevelsFlag) === 0;
}
