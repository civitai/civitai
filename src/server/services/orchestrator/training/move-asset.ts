import { dbWrite } from '~/server/db/client';
import type { MoveAssetInput } from '~/server/schema/training.schema';
import { resolveOwnedApprovedTrainingCheckpoint } from '~/server/services/orchestrator/training/approved-checkpoint';
import { resolveTrainingWorkflowId } from '~/server/services/orchestrator/training/training-state';
import {
  isBlobAssetUrl,
  moveAssetFromBlob,
  moveAssetFromJob,
} from '~/server/services/training.service';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';

/**
 * Copy a training checkpoint into storage under `modelVersionId`. The caller must own the version's
 * model (or be a moderator), and a blob must be a finished checkpoint, with approved training data,
 * of the training run recorded on the version and owned by the version's owner.
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
    const checkpointUrl = await resolveOwnedApprovedTrainingCheckpoint({
      ownerId,
      callerId: userId,
      workflowId: resolveTrainingWorkflowId(version).workflowId,
      requestedUrl: url,
    });
    return moveAssetFromBlob({ url: checkpointUrl, modelVersionId });
  }

  return moveAssetFromJob({ url, modelVersionId, ownerId });
}
