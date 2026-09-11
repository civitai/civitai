// Server half of the training writes: env trace mode + per-user signal callbacks, delegating to the
// client-safe builders in $lib/train-core (shared with the web-component backend).
import { env } from '$env/dynamic/private';
import { orchestratorClient } from './orchestrator';
import { workflowSignalCallbacks } from './signals';
import * as core from '$lib/train-core';
import type { ContinueOpts, TrainingRunInput } from '$lib/train-core';

export type { ContinueOpts, TrainingItem, TrainingRunInput } from '$lib/train-core';

// Live NDJSON tracing is in production orchestrator-side, so it defaults ON; TRAINING_TRACE_MODE
// (`events` | `logs` | `none`) remains the kill switch if the submit ever starts rejecting it.
const TRACE_MODE = env.TRAINING_TRACE_MODE ?? 'events';

/** Submit a batch of training workflows (see `core.submitTrainingBatch` for the stop-at-first-failure /
 *  partial-return policy). Charges Buzz — the single write in the flow. The `userId` registers the
 *  orchestrator callback that pushes live `workflow-update` signals for each run. */
export function submitTrainingBatch(
  token: string,
  runs: TrainingRunInput[] | undefined,
  userId: number
): Promise<string[]> {
  return core.submitTrainingBatch(orchestratorClient(token), runs, {
    callbacks: workflowSignalCallbacks(userId),
    traceMode: TRACE_MODE,
    onRunError: (err) => console.warn('[training-studio] submitTraining failed', err),
  });
}

/** "Keep training": submit a new run continuing from a checkpoint. Charges Buzz. Returns the new run id. */
export function continueTraining(
  token: string,
  userId: number,
  opts: ContinueOpts
): Promise<string> {
  return core.continueTraining(orchestratorClient(token), opts, {
    callbacks: workflowSignalCallbacks(userId),
    traceMode: TRACE_MODE,
  });
}

/** Price a "keep training" continuation without submitting (the same body, `whatif`). */
export function continueTrainingWhatIf(
  token: string,
  userId: number,
  opts: ContinueOpts
): Promise<{ cost: number | null; steps: number | undefined }> {
  return core.continueTrainingWhatIf(orchestratorClient(token), opts, {
    callbacks: workflowSignalCallbacks(userId),
    traceMode: TRACE_MODE,
  });
}

/** Rename a training. Per-user — the token only resolves the caller's own workflows. */
export function renameTraining(token: string, workflowId: string, name: string): Promise<void> {
  return core.renameTraining(orchestratorClient(token), workflowId, name);
}
