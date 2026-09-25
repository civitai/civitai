import {
  MAX_MANUAL_CHECKPOINTS_PER_IMAGE,
  MAX_MANUAL_RESOURCES_PER_IMAGE,
} from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';

type ImageResourceLike = {
  modelVersionId: number;
  modelType?: ModelType | null;
  detected?: boolean | null;
};

export const manualResourceLimitMessages = {
  total: `Images can have at most ${MAX_MANUAL_RESOURCES_PER_IMAGE} manually added resources.`,
  checkpoints: `Images can have at most ${MAX_MANUAL_CHECKPOINTS_PER_IMAGE} manually added checkpoints.`,
};

// Matches the search index's `modelVersionIdsManual` (`detected is not true`).
const isManual = (resource: ImageResourceLike) => resource.detected !== true;

export function getManualResourceUsage(resources: ImageResourceLike[]) {
  const manual = resources.filter(isManual);
  return {
    total: manual.length,
    checkpoints: manual.filter((r) => r.modelType === ModelType.Checkpoint).length,
  };
}

/**
 * Returns the limit message that adding `adding` to an image with `existing` resources would
 * break, or null if it fits. Resources already on the image are skipped, since re-adding one
 * creates no row.
 */
export function getManualResourceLimitError(
  existing: ImageResourceLike[],
  adding: ImageResourceLike[]
): string | null {
  const seenIds = new Set(existing.map((r) => r.modelVersionId));
  const newResources: ImageResourceLike[] = [];
  for (const resource of adding) {
    if (seenIds.has(resource.modelVersionId)) continue;
    seenIds.add(resource.modelVersionId);
    newResources.push({ ...resource, detected: false });
  }
  if (!newResources.length) return null;

  const current = getManualResourceUsage(existing);
  const added = getManualResourceUsage(newResources);
  if (current.total + added.total > MAX_MANUAL_RESOURCES_PER_IMAGE)
    return manualResourceLimitMessages.total;
  // Checked only when adding a checkpoint, so an image already over the checkpoint limit can
  // still be credited with other resource types.
  if (
    added.checkpoints &&
    current.checkpoints + added.checkpoints > MAX_MANUAL_CHECKPOINTS_PER_IMAGE
  )
    return manualResourceLimitMessages.checkpoints;
  return null;
}
