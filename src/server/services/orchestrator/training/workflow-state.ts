import type {
  ImageResourceTrainingOutput,
  ImageResourceTrainingStep,
  TrainingOutput,
  TrainingStep,
  Workflow,
  WorkflowStatus,
} from '@civitai/client';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import { TrainingStatus } from '~/shared/utils/prisma/enums';

// ----- Training workflow status update logic -----

type WorkflowStepMetadata = { modelFileId: number };
export type CustomImageResourceTrainingStep = ImageResourceTrainingStep & {
  metadata: WorkflowStepMetadata;
};
export type CustomTrainingStep = TrainingStep & {
  metadata: WorkflowStepMetadata;
};

export const mapWorkflowStatusToTrainingStatus: { [key in WorkflowStatus]: TrainingStatus } = {
  unassigned: TrainingStatus.Submitted,
  preparing: TrainingStatus.Submitted,
  scheduled: TrainingStatus.Submitted,
  processing: TrainingStatus.Processing,
  failed: TrainingStatus.Failed,
  expired: TrainingStatus.Expired,
  canceled: TrainingStatus.Failed,
  succeeded: TrainingStatus.InReview,
};

/**
 * Base type for PERMANENT, non-retryable failures of the training webhook path:
 * conditions where retrying the workflow callback will deterministically fail
 * again (the orchestrator re-delivers the identical workflow every time). The
 * webhook handler catches this base type and acks (200) instead of returning
 * 500, so a single orphaned/malformed training can't turn into a
 * retry-amplified 500 storm. A genuine TRANSIENT failure (DB error, dependency
 * timeout, unexpected bug) throws a plain Error instead and stays a 5xx so the
 * orchestrator's retry can legitimately recover it.
 */
export class PermanentTrainingWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentTrainingWebhookError';
  }
}

/**
 * Thrown when the training's backing ModelFile no longer exists (deleted or
 * orphaned training) — the dominant observed storm cause. A subtype of
 * PermanentTrainingWebhookError, so the handler treats it the same way.
 */
export class TrainingRecordNotFoundError extends PermanentTrainingWebhookError {
  constructor(message: string) {
    super(message);
    this.name = 'TrainingRecordNotFoundError';
  }
}

export type DerivedTrainingWorkflowState = {
  modelFileId: number;
  trainingStatus: TrainingStatus;
  epochs: TrainingResultsV2['epochs'];
  sampleImagesPrompts: string[];
  workflowId: string | null;
  /** Null when the workflow carries no value, so callers keep whatever they already stored. */
  submittedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  transactionData: TrainingResultsV2['transactionData'] | null;
};

/**
 * The single mapping from an orchestrator workflow to our training state. Shared by the
 * write path (webhook / cron / recheck) and the read overlay, so a row rendered from the
 * live workflow and the same row rendered from its stored copy cannot disagree about what
 * a given workflow means.
 */
export function deriveTrainingWorkflowState(
  workflow: Workflow,
  status: WorkflowStatus
): DerivedTrainingWorkflowState {
  const { transactions, steps, id: workflowId, createdAt, status: workflowStatus } = workflow;

  const step = steps?.[0] as (CustomImageResourceTrainingStep | CustomTrainingStep) | undefined;
  // Permanent: the workflow is created WITH its step + modelFileId metadata
  // (see training.orch.ts). If the re-fetched workflow lacks either, the record
  // is malformed/orphaned and every retry re-derives the same absence — ack it.
  if (!step) throw new PermanentTrainingWebhookError('Missing step data');
  if (!step.metadata.modelFileId) throw new PermanentTrainingWebhookError('Missing modelFileId');

  const {
    metadata: { modelFileId },
    output,
    startedAt,
    completedAt,
  } = step;

  let trainingStatus = mapWorkflowStatusToTrainingStatus[workflowStatus ?? status];

  // Determine step type and extract data accordingly
  const stepType = step.$type;
  let epochs: Array<{
    epochNumber?: number;
    blobUrl?: string;
    blobSize?: number | null;
    sampleImages?: string[];
  }> = [];
  let sampleImagesPrompts: string[] = [];
  let moderationStatus: string | undefined;

  if (stepType === 'training') {
    // TrainingStep: new AI Toolkit format
    const trainingStep = step as CustomTrainingStep;
    moderationStatus = output?.moderationStatus;
    sampleImagesPrompts = trainingStep.input?.samples?.prompts ?? [];

    // Map TrainingEpochResult to our internal format
    const trainingOutput = output as TrainingOutput | undefined;
    epochs = (trainingOutput?.epochs ?? []).map((epoch) => ({
      epochNumber: epoch.epochNumber ?? -1,
      blobUrl: epoch.model?.url ?? '',
      blobSize: 0, // Not provided in TrainingStep
      sampleImages: (epoch.samples ?? []).map((s) => s.url ?? ''),
    }));
  } else if (stepType === 'imageResourceTraining') {
    // ImageResourceTrainingStep: legacy format
    const imageOutput = output as ImageResourceTrainingOutput | undefined;
    epochs = (imageOutput?.epochs ?? []).map((e) => ({
      epochNumber: e.epochNumber ?? -1,
      blobUrl: e.blobUrl,
      blobSize: e.blobSize ?? null,
      sampleImages: e.sampleImages ?? [],
    }));
    sampleImagesPrompts = imageOutput?.sampleImagesPrompts ?? [];
    moderationStatus = imageOutput?.moderationStatus;
  } else {
    // Permanent: the step's $type is fixed at workflow creation; a type we
    // don't handle won't become handleable on retry (retrying just re-fetches
    // the same type). Ack + warn so a code-side gap surfaces without storming.
    throw new PermanentTrainingWebhookError(`Unsupported step type: ${stepType}`);
  }

  if (moderationStatus === 'underReview') trainingStatus = TrainingStatus.Paused;
  else if (moderationStatus === 'rejected') {
    // If the workflow expired, the rejection was due to timeout, not a moderator decision
    if (trainingStatus !== TrainingStatus.Expired) {
      trainingStatus = TrainingStatus.Denied;
    }
  }

  return {
    modelFileId,
    trainingStatus,
    epochs: epochs.map((e) => ({
      epochNumber: e.epochNumber ?? -1,
      modelUrl: e.blobUrl ?? '',
      modelSize: e.blobSize ?? 0,
      sampleImages: e.sampleImages ?? [],
    })),
    sampleImagesPrompts,
    workflowId: workflowId ?? null,
    submittedAt: createdAt ? new Date(createdAt).toISOString() : null,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    completedAt: completedAt ? new Date(completedAt).toISOString() : null,
    transactionData: transactions?.list ?? null,
  };
}

/** Tag `createTrainingWorkflow` puts on every training workflow, and the only handle we have to find them again. */
export const TRAINING_WORKFLOW_TAG = 'training';

/**
 * Orchestrator workflow records are retained for 30 days. Asking for anything older returns
 * nothing, so the query is bounded to the window that can actually answer — and a run outside
 * it keeps rendering its stored copy, which is all that survives of it anyway.
 */
export const TRAINING_WORKFLOW_RETENTION_DAYS = 30;

/**
 * Statuses the orchestrator does not own. `Approved` is written when the user picks an epoch
 * and publishes, long after the workflow succeeded; overlaying that workflow would walk them
 * back to `InReview` and re-offer a choice they already made.
 */
const CIVITAI_OWNED_STATUSES: ReadonlySet<TrainingStatus> = new Set([TrainingStatus.Approved]);

export type TrainingWorkflowOverlay = {
  /** Keyed by the `modelFileId` each training step carries in its metadata. */
  byModelFileId: Map<number, DerivedTrainingWorkflowState>;
  /** More workflows exist in the window than the cap fetched; some rows kept stored state. */
  truncated: boolean;
};

export const emptyTrainingOverlay = (): TrainingWorkflowOverlay => ({
  byModelFileId: new Map(),
  truncated: false,
});

type OverlayableFile = { id: number; metadata: unknown };
type OverlayableVersion = {
  trainingStatus: TrainingStatus | null;
  files: OverlayableFile[];
};

/**
 * Replaces a version's stored training state with its workflow's, where the workflow is still
 * inside the retention window. Returns a new object; the input is untouched.
 */
export function applyTrainingWorkflowOverlay<T extends OverlayableVersion>(
  version: T,
  overlay: TrainingWorkflowOverlay
): T {
  if (overlay.byModelFileId.size === 0) return version;
  if (version.trainingStatus && CIVITAI_OWNED_STATUSES.has(version.trainingStatus)) return version;

  let liveStatus: TrainingStatus | undefined;
  const files = version.files.map((file) => {
    const derived = overlay.byModelFileId.get(file.id);
    if (!derived) return file;
    liveStatus ??= derived.trainingStatus;

    const metadata = (file.metadata ?? {}) as FileMetadata;
    const stored = (metadata.trainingResults ?? {}) as Partial<TrainingResultsV2>;
    const history = stored.history ?? [];

    const trainingResults: TrainingResultsV2 = {
      ...stored,
      version: 2,
      workflowId: derived.workflowId ?? stored.workflowId ?? 'unk',
      submittedAt: derived.submittedAt ?? stored.submittedAt ?? '',
      // Sticky: once a run has started, a workflow read that omits the field must not un-start it.
      startedAt: stored.startedAt ?? derived.startedAt,
      completedAt: derived.completedAt,
      epochs: derived.epochs,
      history: appendLiveStatus(history, derived),
      sampleImagesPrompts: derived.sampleImagesPrompts,
      transactionData: derived.transactionData ?? stored.transactionData ?? [],
    };

    return { ...file, metadata: { ...metadata, trainingResults } };
  });

  if (!liveStatus) return version;
  return { ...version, trainingStatus: liveStatus, files };
}

/**
 * The stored history is the only record of how a run got where it is, and the status timeline in
 * the UI reads it — so a status the overlay surfaced but the write path never recorded has to show
 * up there too, or the row's status and its own history disagree. Timestamped from the workflow
 * rather than from now, since the transition happened whenever the workflow says it did.
 */
function appendLiveStatus(
  history: NonNullable<TrainingResultsV2['history']>,
  derived: DerivedTrainingWorkflowState
): TrainingResultsV2['history'] {
  if (history[history.length - 1]?.status === derived.trainingStatus) return history;
  const time = derived.completedAt ?? derived.startedAt ?? derived.submittedAt;
  if (!time) return history;
  return [...history, { time, status: derived.trainingStatus }];
}

export type TrainingWorkflowRef = { modelFileId: number; workflowId: string };

/**
 * The `(modelFileId, workflowId)` pairs on a page of training rows, so the overlay can tell which
 * rows it failed to cover and go back for them individually.
 */
export function collectTrainingWorkflowRefs(versions: OverlayableVersion[]): TrainingWorkflowRef[] {
  const refs: TrainingWorkflowRef[] = [];
  for (const version of versions) {
    if (version.trainingStatus && CIVITAI_OWNED_STATUSES.has(version.trainingStatus)) continue;
    for (const file of version.files) {
      const stored = ((file.metadata ?? {}) as FileMetadata).trainingResults as
        | Partial<TrainingResultsV2>
        | undefined;
      const workflowId = stored?.workflowId;
      if (workflowId) refs.push({ modelFileId: file.id, workflowId });
    }
  }
  return refs;
}
