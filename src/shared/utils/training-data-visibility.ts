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
