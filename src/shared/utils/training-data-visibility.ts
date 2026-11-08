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
 * bitwise rating of every item in the zip). Only a red-capable host serves a mature dataset; a
 * dataset with no rating counts as mature.
 */
export function trainingDataServableOnHost(nsfwLevel: unknown, redCapable: boolean): boolean {
  if (redCapable) return true;
  return (
    typeof nsfwLevel === 'number' && nsfwLevel > 0 && (nsfwLevel & ~sfwBrowsingLevelsFlag) === 0
  );
}
