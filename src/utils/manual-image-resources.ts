import {
  MAX_MANUAL_CHECKPOINTS_PER_IMAGE,
  MAX_MANUAL_RESOURCES_PER_IMAGE,
} from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';

// Required rather than optional, so a query that stops selecting `modelType` or `detected` fails to
// compile instead of silently counting nothing as a checkpoint, or everything as manual.
type ImageResource = {
  modelVersionId: number;
  modelType: ModelType | null;
  detected: boolean | null;
};
type NewResource = Pick<ImageResource, 'modelVersionId' | 'modelType'>;

export const manualResourceLimitMessages = {
  total: `Images can have at most ${MAX_MANUAL_RESOURCES_PER_IMAGE} manually added resources.`,
  checkpoints: `Images can have at most ${MAX_MANUAL_CHECKPOINTS_PER_IMAGE} manually added checkpoints.`,
};

// Matches the search index's `modelVersionIdsManual` (`detected is not true`).
const isManual = (resource: ImageResource) => resource.detected !== true;

export function getManualResourceUsage(resources: ImageResource[]) {
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
  existing: ImageResource[],
  adding: NewResource[]
): string | null {
  const seenIds = new Set(existing.map((r) => r.modelVersionId));
  const newResources: ImageResource[] = [];
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

/** Splits a multi-pick into the resources that fit, in order, and the first limit message hit. */
export function pickAddableResources<T extends NewResource>(existing: ImageResource[], picks: T[]) {
  const accepted: T[] = [];
  let error: string | null = null;
  for (const pick of picks) {
    const pickError = getManualResourceLimitError(existing, [...accepted, pick]);
    if (pickError) error ??= pickError;
    else accepted.push(pick);
  }
  return { accepted, error };
}
