import { dbWrite } from '~/server/db/client';
import type { MoveAssetInput } from '~/server/schema/training.schema';
import { resolveOwnedApprovedTrainingCheckpoint } from '~/server/services/orchestrator/training/approved-checkpoint';
import { resolveTrainingWorkflowId } from '~/server/services/orchestrator/training/training-state';
import { moveAssetFromBlob, moveAssetFromJob } from '~/server/services/training.service';
import { assertVersionAcceptsNewUpload } from '~/server/utils/model-file-replace';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { isConsumerBlobUrl, parseJobAssetUrl } from '~/shared/orchestrator/blob-url';

const UNSUPPORTED_TRAINING_FILE_MESSAGE =
  'This training run is too old to import; its files are no longer available.';

/**
 * Copy a training checkpoint into storage under `modelVersionId`. The caller must own the version's
 * model (or be a moderator), and the URL must name a finished checkpoint, with approved training
 * data, of the training run recorded on the version and owned by the version's owner. Any other
 * URL — including the asset URL of a pre-workflow training job, which has no run to check — is
 * refused.
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
      status: true,
      trainingStatus: true,
      model: { select: { userId: true } },
      files: { where: { type: 'Training Data' }, select: { metadata: true } },
    },
  });
  if (!version) throw throwNotFoundError(`No model version with id ${modelVersionId}`);
  const ownerId = version.model.userId;
  if (ownerId !== userId && !isModerator) throw throwAuthorizationError();
  // Before any copy: the checkpoint becomes the version's model file, which a published version no
  // longer takes.
  assertVersionAcceptsNewUpload(version, 'Model');

  const { stored, workflowId } = resolveTrainingWorkflowId(version);
  if (!isConsumerBlobUrl(url) && !(workflowId && parseJobAssetUrl(url)))
    throw throwBadRequestError(UNSUPPORTED_TRAINING_FILE_MESSAGE);

  const checkpointUrl = await resolveOwnedApprovedTrainingCheckpoint({
    ownerId,
    callerId: userId,
    workflowId,
    requestedUrl: url,
  });
  if (isConsumerBlobUrl(checkpointUrl))
    return moveAssetFromBlob({ url: checkpointUrl, modelVersionId });

  const jobAsset = parseJobAssetUrl(checkpointUrl);
  if (!jobAsset) throw throwBadRequestError(UNSUPPORTED_TRAINING_FILE_MESSAGE);
  return moveAssetFromJob({
    ...jobAsset,
    modelVersionId,
    submittedAt: stored?.submittedAt ? new Date(stored.submittedAt) : undefined,
  });
}
