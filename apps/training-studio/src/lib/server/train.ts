// Server half of the training writes: env trace mode + per-user signal callbacks, delegating to the
// client-safe builders in $lib/train-core (shared with the web-component backend).
import { env } from '$env/dynamic/private';
import { logToAxiom, safeError } from './axiom';
import { orchestratorClient } from './orchestrator';
import { workflowSignalCallbacks } from './signals';
import { requestTextCheck } from './text-check';
import { getTrainingServiceStatus } from './service-status';
import * as core from '$lib/train-core';
import type { ContinueOpts, SubmittedBatch, TrainingRunInput } from '$lib/train-core';
import type { DatasetRating } from '$lib/dataset-rating';
import { warmDatasetRating } from './dataset-rating';

export type { ContinueOpts, TrainingItem, TrainingRunInput } from '$lib/train-core';
export { MatureAckRequiredError } from '$lib/train-core';

// Live NDJSON tracing is in production orchestrator-side, so it defaults ON; TRAINING_TRACE_MODE
// (`events` | `logs` | `none`) remains the kill switch if the submit ever starts rejecting it.
const TRACE_MODE = env.TRAINING_TRACE_MODE ?? 'events';

/** Submit a batch of training workflows (see `core.submitTrainingBatch` for the stop-at-first-failure /
 *  partial-return policy). Charges Buzz — the single write in the flow. The `userId` registers the
 *  orchestrator callback that pushes live `workflow-update` signals for each run; `cookie` is the
 *  caller's, forwarded to the main app's trigger word check. */
export async function submitTrainingBatch(
  token: string,
  runs: TrainingRunInput[] | undefined,
  userId: number,
  /** null in the dev-login preview, which has no session to send the check with. */
  cookie: string | null,
  /** From `datasetRatingFor`; undefined counts datasets from the upload rating. */
  datasetRating?: DatasetRating,
  /** From `isKohyaAllowed`; a Kohya run is refused without it. */
  kohyaAllowed = false
): Promise<SubmittedBatch> {
  return core.submitTrainingBatch(orchestratorClient(token), runs, {
    status: await getTrainingServiceStatus(),
    kohyaAllowed,
    checkText: requestTextCheck(cookie, userId),
    datasetRating,
    onMatureCount: datasetRating
      ? ({ unratedKeys, ...count }) =>
          void logToAxiom({
            name: 'training-studio-dataset-rating',
            type: 'info',
            message: 'submit mature count',
            userId,
            ...count,
            unrated: unratedKeys.length,
          })
      : undefined,
    callbacks: workflowSignalCallbacks(userId),
    traceMode: TRACE_MODE,
    onRunError: (err, runIndex) =>
      void logToAxiom({
        name: 'training-studio-submit',
        type: 'error',
        message: 'submitTraining failed',
        userId,
        runIndex,
        runCount: runs?.length,
        status: err instanceof core.TrainingSubmitError ? err.status : undefined,
        reason: core.submitFailureReason(err),
        ...(err instanceof core.TrainingSubmitError ? {} : { error: safeError(err) }),
      }),
  });
}

/** "Keep training": submit a new run continuing from a checkpoint. Charges Buzz. Returns the new run id. */
export async function continueTraining(
  token: string,
  userId: number,
  opts: ContinueOpts,
  /** null in the dev-login preview, which has no session to send the check with. */
  cookie: string | null,
  datasetRating?: DatasetRating,
  kohyaAllowed = false
): Promise<string> {
  return core.continueTraining(orchestratorClient(token), opts, {
    status: await getTrainingServiceStatus(),
    kohyaAllowed,
    datasetRating,
    checkText: requestTextCheck(cookie, userId),
    callbacks: workflowSignalCallbacks(userId),
    traceMode: TRACE_MODE,
  });
}

/** Price a "keep training" continuation without submitting (the same body, `whatif`). */
export async function continueTrainingWhatIf(
  token: string,
  userId: number,
  opts: ContinueOpts,
  datasetRating?: DatasetRating,
  kohyaAllowed = false
): Promise<{ cost: number | null; steps: number | undefined; matureCount: number }> {
  return core.continueTrainingWhatIf(orchestratorClient(token), opts, {
    status: await getTrainingServiceStatus(),
    kohyaAllowed,
    datasetRating,
    // The quote is the continuation's Review: rate the source's unrated images before the submit.
    onMatureCount: datasetRating
      ? ({ unratedKeys }) => warmDatasetRating(token, userId, unratedKeys)
      : undefined,
    traceMode: TRACE_MODE,
  });
}

/** Rename a training. Per-user — the token only resolves the caller's own workflows. */
export function renameTraining(token: string, workflowId: string, name: string): Promise<void> {
  return core.renameTraining(orchestratorClient(token), workflowId, name);
}

export function deleteTraining(token: string, workflowId: string): Promise<void> {
  return core.deleteTraining(orchestratorClient(token), workflowId);
}
