import { dbWrite } from '~/server/db/client';
import type { TrainingResultsV1 } from '~/server/schema/model-file.schema';
import type { MoveAssetInput } from '~/server/schema/training.schema';
import { resolveOwnedApprovedTrainingCheckpoint } from '~/server/services/orchestrator/training/approved-checkpoint';
import { resolveTrainingWorkflowId } from '~/server/services/orchestrator/training/training-state';
import {
  isBlobAssetUrl,
  moveAssetFromBlob,
  moveAssetFromJob,
  parseJobAssetUrl,
} from '~/server/services/training.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

/**
 * For a legacy (pre-workflow) training job asset: returns the asset URL recorded in the version's
 * stored training results whose job id and asset name match `requestedUrl`. That job id must be one
 * the version's stored results record for its own submission (`jobId`, or a `history` entry's).
 * `requestedUrl` only selects which recorded asset; the returned URL is what gets copied.
 *
 * This checks the version's stored records only. Legacy jobs carry no training-data moderation
 * status, so there is no approval check on this path.
 */
export function resolveRecordedJobAssetUrl(
  trainingResults: TrainingResultsV1 | null | undefined,
  requestedUrl: string
): string {
  const recordedJobIds = new Set(
    [trainingResults?.jobId, ...(trainingResults?.history ?? []).map((h) => h.jobId)]
      .filter((id): id is string => !!id)
      .map((id) => id.toLowerCase())
  );
  if (!recordedJobIds.size)
    throw throwBadRequestError('This model version has no recorded training job.');

  const requested = parseJobAssetUrl(requestedUrl);
  const recordedUrl = requested
    ? (trainingResults?.epochs ?? [])
        .map((epoch) => epoch.model_url)
        .find((url) => {
          const recorded = parseJobAssetUrl(url);
          return (
            !!recorded &&
            recordedJobIds.has(recorded.jobId.toLowerCase()) &&
            recorded.jobId.toLowerCase() === requested.jobId.toLowerCase() &&
            recorded.assetName === requested.assetName
          );
        })
    : undefined;
  if (!recordedUrl)
    throw throwBadRequestError("That file is not one of this model version's training outputs.");
  return recordedUrl;
}

/**
 * Copy a training checkpoint into storage under `modelVersionId`. The caller must own the version's
 * model (or be a moderator). A blob must be a finished checkpoint, with approved training data, of
 * the training run recorded on the version and owned by the version's owner; a legacy job asset must
 * be one recorded for the version's own training job (`resolveRecordedJobAssetUrl`).
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

  const { file } = resolveTrainingWorkflowId(version);
  const trainingResults = (file?.metadata as { trainingResults?: TrainingResultsV1 } | null)
    ?.trainingResults;
  return moveAssetFromJob({
    url: resolveRecordedJobAssetUrl(trainingResults, url),
    modelVersionId,
    ownerId,
  });
}
