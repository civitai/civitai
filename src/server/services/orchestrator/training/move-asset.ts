import { dbWrite } from '~/server/db/client';
import type { MoveAssetInput } from '~/server/schema/training.schema';
import { assertOwnedApprovedTrainingCheckpoint } from '~/server/services/orchestrator/training/approved-checkpoint';
import { resolveTrainingWorkflowId } from '~/server/services/orchestrator/training/training-state';
import {
  isBlobAssetUrl,
  moveAssetFromBlob,
  moveAssetFromJob,
} from '~/server/services/training.service';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Copy a training checkpoint into storage under `modelVersionId`. The caller must own the version's
 * model (or be a moderator), and a blob must be a finished checkpoint of the version's own training
 * run with approved training data.
 */
export async function moveAsset({
  url,
  modelVersionId,
  userId,
  isModerator,
}: MoveAssetInput & { userId: number; isModerator: boolean }) {
  // Through dbWrite for the training-file metadata — see resolveTrainingRun.
  const version = await dbWrite.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      meta: true,
      model: { select: { userId: true } },
      files: { where: { type: 'Training Data' }, select: { metadata: true } },
    },
  });
  if (!version) throw throwNotFoundError(`No model version with id ${modelVersionId}`);
  const ownerId = version.model.userId;
  if (ownerId !== userId && !isModerator) throw throwAuthorizationError();

  if (isBlobAssetUrl(url)) {
    await assertOwnedApprovedTrainingCheckpoint({
      ownerId,
      callerId: userId,
      workflowId: resolveTrainingWorkflowId(version).workflowId,
      checkpointUrl: url,
    });
    return moveAssetFromBlob({ url, modelVersionId });
  }

  return moveAssetFromJob({ url, modelVersionId, ownerId });
}
