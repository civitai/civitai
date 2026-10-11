import type {
  ImageResouceTrainingModerationStatus,
  ImageResourceTrainingOutput,
  TrainingModerationStatus,
  TrainingOutput,
  Workflow,
} from '@civitai/client';
import { TRPCError } from '@trpc/server';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getTrainingStep } from '~/server/services/orchestrator/training/publish-from-workflow';
import type { AnyEpoch } from '~/server/services/orchestrator/training/training-epoch-blobs';
import { finishedEpochCheckpoints } from '~/server/services/orchestrator/training/training-epoch-blobs';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';

// A typed literal rather than the client's runtime enum object: `@civitai/client` is mocked in the
// unit test setup, so a value import from it is undefined there.
const APPROVED_TRAINING_MODERATION_STATUS = 'approved' satisfies TrainingModerationStatus &
  ImageResouceTrainingModerationStatus;

const TRAINING_NOT_APPROVED_MESSAGE =
  "This training run's dataset has not been approved, so its files can't be added to a model.";
const NOT_A_RUN_CHECKPOINT_MESSAGE = 'That file is not a checkpoint from this training run.';
const TRAINING_RUN_UNAVAILABLE_MESSAGE = "This model version's training run could not be found.";

/**
 * Throws unless `requestedUrl` names a finished epoch checkpoint of `workflow`'s training step and
 * that step reports an `approved` training-data moderation status (every other status, and a step
 * with none, is refused). Returns the workflow's own URL for that checkpoint: `requestedUrl` only
 * selects which one, and is never fetched.
 */
export function resolveApprovedTrainingCheckpoint(
  workflow: Workflow,
  requestedUrl: string
): string {
  const { step } = getTrainingStep(workflow);
  const output = step.output as TrainingOutput | ImageResourceTrainingOutput | null | undefined;
  if (output?.moderationStatus !== APPROVED_TRAINING_MODERATION_STATUS)
    throw throwBadRequestError(TRAINING_NOT_APPROVED_MESSAGE);

  const blobId = getConsumerBlobId(requestedUrl);
  const checkpoint = blobId
    ? finishedEpochCheckpoints((output.epochs ?? []) as AnyEpoch[]).find((c) =>
        c.keys.includes(blobId)
      )
    : undefined;
  if (!checkpoint?.url) throw throwBadRequestError(NOT_A_RUN_CHECKPOINT_MESSAGE);
  return checkpoint.url;
}

/**
 * Reads `workflowId` with the model OWNER's token — the orchestrator answers NOT_FOUND for a
 * workflow that token does not own — and applies `resolveApprovedTrainingCheckpoint`. A run past
 * retention reads as NOT_FOUND too, and is refused: its checkpoints are gone with it.
 */
export async function resolveOwnedApprovedTrainingCheckpoint({
  ownerId,
  callerId,
  workflowId,
  requestedUrl,
}: {
  ownerId: number;
  callerId: number;
  workflowId: string | undefined;
  requestedUrl: string;
}): Promise<string> {
  if (!workflowId) throw throwBadRequestError(TRAINING_RUN_UNAVAILABLE_MESSAGE);

  const token = await getOrchestratorToken(ownerId, undefined, {
    bypassCache: callerId !== ownerId,
  });
  let workflow: Workflow | undefined;
  try {
    workflow = await getWorkflow({ token, path: { workflowId } });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND')
      throw throwBadRequestError(TRAINING_RUN_UNAVAILABLE_MESSAGE);
    throw error;
  }
  if (!workflow) throw throwBadRequestError(TRAINING_RUN_UNAVAILABLE_MESSAGE);
  return resolveApprovedTrainingCheckpoint(workflow, requestedUrl);
}
