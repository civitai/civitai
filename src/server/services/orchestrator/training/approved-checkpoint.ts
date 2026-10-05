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
import { trainingWorkflowEpochBlobs } from '~/server/services/orchestrator/training/training-epoch-blobs';
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
const TRAINING_RUN_UNAVAILABLE_MESSAGE =
  "This model version's training run could not be found.";

/**
 * Throws unless `checkpointUrl` names a finished epoch checkpoint of `workflow`'s training step and
 * that step reports an `approved` training-data moderation status. Every other status, and a step
 * with none, is refused.
 */
export function assertApprovedTrainingCheckpoint(workflow: Workflow, checkpointUrl: string): void {
  const { step } = getTrainingStep(workflow);
  const output = step.output as TrainingOutput | ImageResourceTrainingOutput | null | undefined;
  if (output?.moderationStatus !== APPROVED_TRAINING_MODERATION_STATUS)
    throw throwBadRequestError(TRAINING_NOT_APPROVED_MESSAGE);

  const blobId = getConsumerBlobId(checkpointUrl);
  const { blobKeys } = trainingWorkflowEpochBlobs({ ...workflow, steps: [step] });
  if (!blobId || !blobKeys.includes(blobId))
    throw throwBadRequestError(NOT_A_RUN_CHECKPOINT_MESSAGE);
}

/**
 * Reads `workflowId` with the model OWNER's token — the orchestrator answers NOT_FOUND for a
 * workflow that token does not own — and applies `assertApprovedTrainingCheckpoint`. A run past
 * retention reads as NOT_FOUND too, and is refused: its checkpoints are gone with it.
 */
export async function assertOwnedApprovedTrainingCheckpoint({
  ownerId,
  callerId,
  workflowId,
  checkpointUrl,
}: {
  ownerId: number;
  callerId: number;
  workflowId: string | undefined;
  checkpointUrl: string;
}): Promise<void> {
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
  assertApprovedTrainingCheckpoint(workflow, checkpointUrl);
}
