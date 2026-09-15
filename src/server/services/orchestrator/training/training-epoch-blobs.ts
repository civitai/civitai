import type {
  EpochResult,
  TrainingOutputEpochResult,
  Workflow,
  WorkflowStatus,
} from '@civitai/client';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';

/**
 * Derived view of a training workflow for raw-AIR epoch generation: every epoch
 * blob key it produced, the training step's completion date (the timestamp the
 * 15-day epoch generation window counts from), and that step's status —
 * consulted when the completion date is null, to tell a still-running step from
 * a canceled/failed/expired one. JSON-safe so it can be cached.
 */
export type TrainingEpochBlobs = {
  blobKeys: string[];
  completedAt: string | null;
  stepStatus: WorkflowStatus | null;
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
type AnyEpoch = Partial<TrainingOutputEpochResult & EpochResult>;

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
  for (const step of workflow.steps ?? []) {
    const epochs = (step as { output?: { epochs?: AnyEpoch[] } }).output?.epochs;
    if (!epochs?.length) continue;
    if (step.completedAt) completedAt = step.completedAt;
    stepStatus = step.status ?? stepStatus;
    for (const epoch of epochs) {
      if (epoch.model?.id) blobKeys.add(epoch.model.id);
      for (const url of [epoch.model?.url, epoch.blobUrl]) {
        const key = url ? getConsumerBlobId(url) : undefined;
        if (key) blobKeys.add(key);
      }
    }
  }
  return { blobKeys: [...blobKeys], completedAt, stepStatus };
}
