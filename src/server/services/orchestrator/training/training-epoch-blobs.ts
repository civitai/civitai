import type {
  EpochResult,
  TrainingOutputEpochResult,
  Workflow,
  WorkflowStatus,
} from '@civitai/client';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';
import { parseAIRSafe } from '~/shared/utils/air';

/**
 * Derived view of a training workflow for raw-AIR epoch generation: every epoch
 * blob key it produced, the training step's completion date (the timestamp the
 * 15-day epoch generation window counts from), that step's status — consulted
 * when the completion date is null, to tell a still-running step from a
 * canceled/failed/expired one — and the ecosystem the step trained on, so the
 * caller can refuse an owned blob relabeled under a different ecosystem's AIR.
 * Null ecosystem = unknown (older runs); callers skip the check. JSON-safe so
 * it can be cached.
 */
export type TrainingEpochBlobs = {
  blobKeys: string[];
  completedAt: string | null;
  stepStatus: WorkflowStatus | null;
  ecosystem: string | null;
};

/** The step statuses workflow-state.ts treats as non-terminal. */
const ACTIVE_STEP_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'unassigned',
  'preparing',
  'scheduled',
  'processing',
]);

/**
 * Whether a null completion date can be trusted as "still training". Fails
 * closed on a missing/unknown status: a real orchestrator step always carries
 * one, and a legitimately completed run always has `completedAt`.
 */
export function isActiveTrainingStepStatus(status: WorkflowStatus | null | undefined): boolean {
  return status != null && ACTIVE_STEP_STATUSES.has(status);
}

/** AI-Toolkit epochs carry `model` (a Blob), legacy epochs carry `blobUrl`. */
export type AnyEpoch = Partial<TrainingOutputEpochResult & EpochResult>;

/**
 * Unlike workflow-state.ts this scans EVERY step for the epoch shape instead of
 * switching on `$type` — tighten to the tag once raw-AIR handoffs are known to
 * only ever name tagged training steps. `completedAt`/`stepStatus` pool across
 * epoch-bearing steps (last one wins) — training workflows have one such step.
 */
export function trainingWorkflowEpochBlobs(workflow: Workflow): TrainingEpochBlobs {
  const blobKeys = new Set<string>();
  let completedAt: string | null = null;
  let stepStatus: WorkflowStatus | null = null;
  let ecosystem: string | null = null;
  for (const step of workflow.steps ?? []) {
    const epochs = (step as { output?: { epochs?: AnyEpoch[] } }).output?.epochs;
    if (!epochs?.length) continue;
    if (step.completedAt) completedAt = step.completedAt;
    stepStatus = step.status ?? stepStatus;
    const input = (step as { input?: { ecosystem?: string; model?: string } }).input;
    ecosystem =
      input?.ecosystem ?? (input?.model ? parseAIRSafe(input.model)?.ecosystem : null) ?? ecosystem;
    for (const checkpoint of finishedEpochCheckpoints(epochs))
      for (const key of checkpoint.keys) blobKeys.add(key);
  }
  return { blobKeys: [...blobKeys], completedAt, stepStatus, ecosystem };
}

/** A finished epoch checkpoint: every blob key that names it, and the URL it is served from. */
export type EpochCheckpoint = { keys: string[]; url: string | undefined };

export function finishedEpochCheckpoints(epochs: AnyEpoch[]): EpochCheckpoint[] {
  const checkpoints: EpochCheckpoint[] = [];
  for (const epoch of epochs) {
    // `available: false` is a checkpoint the run hasn't finished — the studio never offers
    // it, and its blob may not exist yet, so it must not count as owned. Matches the
    // finished-checkpoint filter in workflow-state.ts / mapWorkflowToTrainingResultsV2.
    if (epoch.model && epoch.model.available !== false) {
      const url = epoch.model.url ?? undefined;
      const keys = [epoch.model.id, url ? getConsumerBlobId(url) : undefined];
      checkpoints.push({ keys: keys.filter((key): key is string => !!key), url });
    }
    const legacyKey = epoch.blobUrl ? getConsumerBlobId(epoch.blobUrl) : undefined;
    if (legacyKey) checkpoints.push({ keys: [legacyKey], url: epoch.blobUrl ?? undefined });
  }
  return checkpoints;
}
