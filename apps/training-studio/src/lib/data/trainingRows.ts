import type { AiToolkitTrainingInput, Workflow, WorkflowStatus } from '@civitai/client';
import { slugify } from '$lib/slug';
import {
  cardByAirEcosystem,
  cardByEcosystem,
  cardByType,
  findByAir,
  isMedia,
  mediaCount,
  versionSuffix,
  type Media,
} from './trainingModels';

/** Tags every training workflow carries. `TRAINING_TAG` mirrors the main app's
 * `TRAINING_WORKFLOW_TAG`; `CIVITAI_TAG` is the platform namespace. The main app's queryWorkflows
 * *wrapper* prepends `civitai`, but the raw `@civitai/client` call this app uses does not, so the
 * query must pass both explicitly. */
export const TRAINING_TAG = 'training';
export const CIVITAI_TAG = 'civitai';
/** Marks a free auto-label workflow. These share the training tags but are NOT trainings — the list and
 *  detail mappers drop them so they don't show up as runs. */
export const AUTO_LABEL_TAG = 'auto-label';

/** Version stamped into `Workflow.metadata` by the write path and read back here. Bump when the
 * `TrainingStudioMeta` shape changes incompatibly; the reader degrades field-by-field regardless. */
export const META_VERSION = 1;

/** A pick-able generation blob, as returned by `/api/generations`. Declared here (not on the server
 *  helper) so the route, `listGenerations`, and the picker share one contract across the network boundary. */
export interface GenerationItem {
  blobId: string;
  /** Full blob URL — seeds the dataset (auto-label media + training reference). */
  url: string;
  /** Resized preview for the grid thumbnail; falls back to `url`. */
  previewUrl: string;
  nsfwLevel?: string;
}

/** A run's coarse lifecycle as shown on the My-trainings list. `published` is an app-level
 * fact we store in the workflow metadata, not an orchestrator status. */
export type RunState = 'ready' | 'training' | 'published' | 'failed';

/** Badge presentation per run state, shared by the My-trainings list and the run detail page so the
 * two can't drift when a state is added or recolored. */
export const RUN_STATE_BADGE: Record<RunState, { label: string; cls: string; dot: string }> = {
  ready: { label: 'Ready', cls: 'text-emerald-400 bg-emerald-500/15', dot: 'bg-emerald-400' },
  training: {
    label: 'Training',
    cls: 'text-primary bg-primary/15',
    dot: 'bg-primary animate-pulse',
  },
  published: {
    label: 'Published',
    cls: 'text-emerald-400 bg-emerald-500/15',
    dot: 'bg-emerald-400',
  },
  failed: { label: 'Failed', cls: 'text-red-400 bg-red-500/15', dot: 'bg-red-400' },
};

export interface TrainingRow {
  /** Orchestrator workflow id — the handle for reconnect/open. Absent only for sample rows. */
  workflowId?: string;
  createdAt?: string;
  name: string;
  base: string;
  /** The model family without the version (`SDXL`, not `SDXL · Pony`), for the base filter. */
  baseFamily: string;
  code: string;
  state: RunState;
  sub: string;
  /** 0 when unknown (a running workflow whose step progress we haven't read); the list then
   * shows an indeterminate bar rather than a misleading percentage. */
  progressPct: number;
  progress: string;
  /** Real sample URLs from a finished run's last epoch (the list shows these instead of the gradient
   * placeholders). Empty until a run produces samples. */
  sampleUrls: string[];
  /** The run's media — image / video / audio. Drives sample rendering and the reuse picker's same-media filter. */
  media: Media;
  /** Convenience: video-model samples are `<video>`, not `<img>`. */
  isVideo: boolean;
  /** A Civitai model version reads this run's epoch blobs: a studio draft/published model
   *  (`meta.modelId`) or a main-app trainer run, which is created from its ModelVersion. */
  hasModel: boolean;
}

/** Whether the list offers Delete. A training run is excluded because deleting it is a cancel, and
 *  the orchestrator only refunds work that hasn't started. */
export function canDeleteRun(row: Pick<TrainingRow, 'state' | 'hasModel'>): boolean {
  return (row.state === 'ready' || row.state === 'failed') && !row.hasModel;
}

function workflowHasModel(w: Workflow, meta: TrainingStudioMeta): boolean {
  return (
    typeof meta.modelId === 'number' ||
    (w.tags ?? []).some((t) => t.startsWith('modelVersion:')) ||
    (w.steps ?? []).some(
      (s) => (s.metadata as { modelFileId?: unknown } | null | undefined)?.modelFileId != null
    )
  );
}

/**
 * Training-studio's own state, stored in `Workflow.metadata` since there is no DB. The write
 * path (Start, a later slice) stamps this; the list reads it back. Every field is optional so a
 * partially-written or foreign workflow degrades to a rendered row rather than throwing.
 */
export interface TrainingStudioMeta {
  v?: number;
  name?: string;
  media?: Media;
  loraType?: string;
  /** Base-model card `type` (e.g. `flux`) — resolved to name/code via the model catalog. */
  cardType?: string;
  versionKey?: string;
  imageCount?: number;
  trigger?: string;
  /** Set once the user publishes a public model page off this workflow. */
  published?: boolean;
  /** The run's model/version on Civitai — stamped by the main app when the DRAFT is created
   *  (publish entry) and re-stamped alongside `published`, so the run links its model page at
   *  either stage. */
  modelId?: number;
  modelVersionId?: number;
  /** Lineage of a "train further" run: the run it continued from and the checkpoint it forked at.
   *  Stamped by the continuation submit; absent on fresh runs and on continuations submitted
   *  before lineage shipped. */
  sourceWorkflowId?: string;
  sourceEpoch?: number;
}

const STATE_BY_STATUS: Record<WorkflowStatus, RunState> = {
  unassigned: 'training',
  preparing: 'training',
  scheduled: 'training',
  processing: 'training',
  succeeded: 'ready',
  failed: 'failed',
  canceled: 'failed',
  expired: 'failed',
};

/** The training step's input as we read it back: the SDK's ai-toolkit shape, so a field the
 *  orchestrator renames or retypes fails typecheck here rather than drifting silently, plus the
 *  ecosystem-specific and per-item fields the generic type leaves out. Read defensively — an older
 *  or foreign (main-app) workflow may not carry all of them. */
type TrainingStepInput = Partial<AiToolkitTrainingInput> & {
  /** Base checkpoint AIR, when the run pinned one. */
  model?: string;
  modelVariant?: string;
  version?: string;
  resolution?: number | null;
  /** SD-family only. */
  minSnrGamma?: number | null;
  /** The fixed sample prompts (usually 3). Each epoch generates one image per prompt, positionally. */
  samples?: { prompts?: string[] };
  /** The dataset the run trained on — blob-backed items (a blob `air`/key + its caption). Older or Flux.2
   *  runs may carry a zip URL instead, in which case there are no per-image items to show. */
  trainingData?: { type?: string; items?: Array<{ air?: string; caption?: string }> };
};
/** The weights-blob half of an epoch entry in the training step's output. `id` is the blob's
 *  orchestrator key — the handle continue/generate reference the checkpoint by (as a blob AIR);
 *  `url` is a signed download link. Shared with train-core so "does this epoch have usable weights,
 *  and by what key" (`epochModelKey`) can't fork between the generate hand-off and `continueFrom`. */
export interface EpochModelOutput {
  id?: string;
  url?: string | null;
  available?: boolean;
  /** Weights size in bytes. Only the legacy shape carries one (`blobSize`); the ai-toolkit
   *  `training` shape's blobs have no size field, so this stays undefined there. */
  size?: number | null;
}

export const epochModelKey = (model: EpochModelOutput | undefined): string | undefined =>
  model?.available && typeof model.id === 'string' ? model.id : undefined;

/** One epoch entry in a training step's output, in either shape the orchestrator produces:
 *  the ai-toolkit `training` shape (`model` + `samples`, with blob ids and availability flags), or
 *  the legacy `imageResourceTraining` shape the main-app/old-trainer runs carry (`blobUrl`/`blobSize`
 *  + `sampleImages` URL strings — no availability flags and no blob ids). Mirrors the two branches of
 *  the main app's `mapWorkflowToTrainingResultsV2` (publish-from-workflow.ts). */
interface TrainingEpochOutput {
  epochNumber?: number;
  model?: EpochModelOutput;
  samples?: Array<{ id?: string; url?: string | null; available?: boolean }>;
  /** Tail-able live trace of this epoch's job (present only when the run requested tracing). */
  traceUrl?: string | null;
  blobUrl?: string | null;
  blobSize?: number | null;
  sampleImages?: Array<string | null>;
}

/** The epoch's weights blob across both shapes. A legacy `blobUrl` is downloadable but has no blob
 *  id, so `epochModelKey` stays undefined and key-needing affordances (generate, train further)
 *  degrade away while download keeps working. */
const epochModel = (e: TrainingEpochOutput): EpochModelOutput | undefined =>
  e.model ??
  (typeof e.blobUrl === 'string' && e.blobUrl
    ? { url: e.blobUrl, available: true, size: e.blobSize }
    : undefined);

const epochSamples = (
  e: TrainingEpochOutput
): Array<{ id?: string; url?: string | null; available?: boolean }> =>
  e.samples ??
  (e.sampleImages ?? [])
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .map((url) => ({ url, available: true }));

interface TrainingStepOutput {
  epochs?: TrainingEpochOutput[];
  /** Legacy `imageResourceTraining` runs carry the sample prompts here, not on the input. */
  sampleImagesPrompts?: string[];
}

/**
 * Shared read of a workflow's `training` step + base-model resolution, used by both the list row and the
 * detail. Data comes from the step (base model from its `air`/`ecosystem`, epochs from its output) plus our
 * own `TrainingStudioMeta` when present — existing (main-app-created) runs carry no metadata, so the step is
 * the source. `state` is undefined for a status we can't map; callers drop the workflow.
 */
function resolveWorkflow(w: Workflow) {
  const meta = (w.metadata ?? {}) as TrainingStudioMeta;
  // `status` is typed non-null but the orchestrator can omit it on a run mid-transition (the main app's
  // read paths guard `!workflow.status`), so an unmapped status yields no state and the caller drops it.
  const state: RunState | undefined = meta.published ? 'published' : STATE_BY_STATUS[w.status];

  const step =
    w.steps?.find((s) => (s as { $type?: string }).$type === 'training') ??
    w.steps?.find((s) => (s as { $type?: string }).$type === 'imageResourceTraining') ??
    w.steps?.[0];
  const input = ((step as { input?: TrainingStepInput } | undefined)?.input ??
    {}) as TrainingStepInput;
  const output = ((step as { output?: TrainingStepOutput } | undefined)?.output ??
    {}) as TrainingStepOutput;
  // The orchestrator's 0–1 estimate of overall step progress (refreshed on each job event); the general
  // "how far along" the run is, independent of the per-epoch checkpoints.
  const rate = (step as { estimatedProgressRate?: number | null } | undefined)
    ?.estimatedProgressRate;
  const progress = typeof rate === 'number' ? Math.max(0, Math.min(1, rate)) : undefined;

  // Base model: the exact `air` the run trained on, else the card the user picked (metadata), else
  // the step's ecosystem. cardType must beat the ecosystem fallback: several cards share an
  // ecosystem (Illustrious/Pony/a custom checkpoint are all `sdxl`), so ecosystem-first showed
  // every one of them as "SDXL" instead of the base the run actually trained on.
  const byAir = input.model ? findByAir(input.model) : undefined;
  const card =
    byAir?.card ??
    (meta.cardType ? cardByType(meta.cardType) : undefined) ??
    (input.ecosystem ? cardByEcosystem(input.ecosystem) : undefined) ??
    (input.model ? cardByAirEcosystem(input.model) : undefined);
  const version = byAir?.version ?? card?.versions.find((v) => v.key === meta.versionKey);

  return {
    meta,
    state,
    input,
    output,
    progress,
    startedAt: (step as { startedAt?: string | null } | undefined)?.startedAt ?? undefined,
    completedAt: (step as { completedAt?: string | null } | undefined)?.completedAt ?? undefined,
    // The studio stamps the chosen media, so it wins over the card; the 'image' default is only for a
    // foreign run no catalog lookup could place.
    media: isMedia(meta.media) ? meta.media : card?.media ?? 'image',
    base: card
      ? `${card.name}${
          versionSuffix(card.name, version?.label)
            ? ` · ${versionSuffix(card.name, version?.label)}`
            : ''
        }`
      : 'Training run',
    baseFamily: card?.name ?? 'Other',
    code: card?.code ?? '??',
    // TODO(write-path): main-app runs carry no name tag, so we show the trigger word or a fallback. The
    // Start slice should stamp a `name` (and a `name:<slug>` workflow tag) so runs are titled properly.
    name: meta.name || meta.trigger || input.triggerWord || 'Untitled training',
  };
}

/** Whole-run progress 0–100: finished checkpoints plus the current epoch's fraction, over the plan. The
 *  orchestrator's `estimatedProgressRate` is PER-EPOCH (0→1 within the current epoch), so used raw it reads
 *  as far more done than the run is — fold it into the completed count instead. Shared by the overview card
 *  and the detail page so the two can't disagree. */
export function overallProgressPct(
  completedEpochs: number,
  plannedEpochs: number | undefined,
  rate: number | undefined
): number {
  const r = typeof rate === 'number' ? Math.max(0, Math.min(1, rate)) : 0;
  if (plannedEpochs && plannedEpochs > 0)
    return Math.min(100, Math.round(((completedEpochs + r) / plannedEpochs) * 100));
  return typeof rate === 'number' ? Math.round(r * 100) : 0;
}

/** An epoch that has produced something (a finished checkpoint or a sample). The single predicate
 *  behind every "checkpoint N" counter AND the detail's epoch list — stated once so the list row
 *  and the detail page can't disagree about how many checkpoints exist. */
const epochHasOutput = (e: TrainingEpochOutput): boolean => {
  const model = epochModel(e);
  return Boolean(
    (model?.available && model.url) || epochSamples(e).some((s) => s.available && s.url)
  );
};

/** Epochs that have produced something — the "N complete" count. */
function completedEpochCount(epochs: TrainingStepOutput['epochs']): number {
  return (epochs ?? []).filter(epochHasOutput).length;
}

/** Map one orchestrator workflow to a My-trainings row. Returns null for a workflow we can't place. */
export function workflowToRow(w: Workflow): TrainingRow | null {
  if (!w.id || w.tags?.includes(AUTO_LABEL_TAG)) return null;
  const {
    meta,
    state,
    input,
    output,
    base,
    baseFamily,
    code,
    name,
    media,
    progress: progressRate,
  } = resolveWorkflow(w);
  if (!state) return null;

  const epochCount = output.epochs?.length ?? input.epochs;
  const parts: string[] = [];
  if (typeof meta.imageCount === 'number') parts.push(mediaCount(meta.imageCount, media));
  if (epochCount) parts.push(`${epochCount} epochs`);
  if (meta.loraType) parts.push(meta.loraType);

  // Thumbnails: up to 4 sample images, newest epoch first (only `available` blobs carry a URL). A single
  // epoch often has fewer than 4, so we fill from the most recent epochs backward.
  const sampleUrls: string[] = [];
  for (const epoch of [...(output.epochs ?? [])].reverse()) {
    for (const s of epochSamples(epoch)) {
      if (sampleUrls.length >= 4) break;
      if (s.available && typeof s.url === 'string') sampleUrls.push(s.url);
    }
    if (sampleUrls.length >= 4) break;
  }

  const completedEpochs = completedEpochCount(output.epochs);

  return {
    workflowId: w.id,
    createdAt: w.createdAt,
    name,
    base,
    baseFamily,
    code,
    state,
    sub: parts.join(' · '),
    progressPct: overallProgressPct(completedEpochs, input.epochs ?? undefined, progressRate),
    // COMPLETED checkpoints, starting at 0/N — the main site's counter shape ("Progress: 0/10"),
    // and what the detail header shows; "epoch N+1" read as one already done.
    progress:
      state === 'training'
        ? input.epochs
          ? `checkpoint ${completedEpochs} / ${input.epochs}`
          : w.status
        : '',
    sampleUrls,
    media,
    isVideo: media === 'video',
    hasModel: workflowHasModel(w, meta),
  };
}

/** One epoch/checkpoint of a finished run, for the detail screen. */
export interface TrainingDetailEpoch {
  /** Stable within a run — the loop key and the selection identity. `number` alone isn't safe: its
   * `?? 0` fallback collapses numberless epochs, so we suffix the array position. */
  id: string;
  number: number;
  /** One entry PER PROMPT, index-aligned to `TrainingDetail.prompts` — so `samples[i]` is this epoch's
   * image for `prompts[i]`. `null` where that prompt's image is missing/unavailable for this epoch. */
  samples: (string | null)[];
  /** The trained weights blob (a signed URL), when the epoch produced an available one. */
  modelUrl?: string;
  /** The weights blob's orchestrator key — with the run's ecosystem it forms the epoch's LoRA blob
   *  AIR (train-core's `loraBlobAir`) for the generate hand-off. */
  modelKey?: string;
  /** Weights file size in bytes, when the payload carries one (legacy runs only — see
   *  EpochModelOutput.size). */
  sizeBytes?: number;
}

/** One dataset image the run trained on: the blob reference (resolved to a viewable URL through the
 *  dataset-blob proxy) and the caption/tags it was labeled with. */
export interface DatasetItem {
  air: string;
  caption: string;
}

/** The training-step input keys the settings export carries. `trainingData` (signed blob URLs) and
 *  anything else on the input stay out. */
const SETTINGS_INPUT_KEYS = [
  'engine',
  'ecosystem',
  'modelVariant',
  'version',
  'model',
  'steps',
  'epochs',
  'batchSize',
  'lr',
  'textEncoderLr',
  'trainTextEncoder',
  'lrScheduler',
  'optimizerType',
  'networkDim',
  'networkAlpha',
  'resolution',
  'shuffleTokens',
  'keepTokens',
  'minSnrGamma',
  'noiseOffset',
  'flipAugmentation',
  'triggerWord',
  'continueFrom',
] as const satisfies readonly (keyof TrainingStepInput)[];

/** A run's effective configuration, read off the workflow's training step — never rebuilt from UI
 *  defaults. */
export interface TrainingSettingsExport {
  workflowId: string;
  name: string;
  createdAt: string;
  media: Media;
  /** Our own Select-step choices, when the run was started here (absent on main-app runs). */
  loraType?: string;
  cardType?: string;
  versionKey?: string;
  imageCount: number;
  samplePrompts: string[];
  /** The training step's input, filtered to the run-describing fields. Keys are the orchestrator's
   *  own names (`lr`, `optimizerType`, …), not the form's. */
  training: Partial<Pick<TrainingStepInput, (typeof SETTINGS_INPUT_KEYS)[number]>>;
}

/** One epoch's trace stream. `done` once that epoch's weights have landed, i.e. its trace is complete. */
export interface EpochTrace {
  epoch: number;
  url: string;
  done: boolean;
}

/** The epoch training now, or -1 once every epoch is done. The orchestrator pre-creates ALL epoch entries
 *  up front, each with a traceUrl, and marks them done as weights land — so it's the LOWEST-numbered one
 *  without finished weights. Later epochs' traces aren't written until their turn. */
export const liveTraceIndex = (traces: EpochTrace[]) => traces.findIndex((t) => !t.done);

/** A single training run's detail, for the Open screen. */
export interface TrainingDetail {
  workflowId: string;
  name: string;
  base: string;
  code: string;
  state: RunState;
  createdAt: string;
  /** When the training step started running — with `completedAt` it gives the run's wall-clock
   *  duration. Absent on runs whose step carries no start date. */
  startedAt?: string;
  /** When the training step finished — the anchor for the 30-day retention countdown. Absent while
   *  running and on runs whose step carries no completion date (retention then anchors at createdAt,
   *  which can only warn early, never late). */
  completedAt?: string;
  /** The training step's orchestrator ecosystem (e.g. `sdxl`) — what an epoch's blob AIR is scoped
   *  by. Absent on runs whose step carries none (older main-app runs). */
  ecosystem?: string;
  /** Sample media type — drives how samples render (image tiles, `<video>`, or a full-width `<audio>` card). */
  media: Media;
  /** Convenience: video-model samples are `<video>`. */
  isVideo: boolean;
  /** The fixed sample prompts (usually 3). Rows of the compare grid; captions for each epoch's images. */
  prompts: string[];
  /** The requested checkpoint count, for a "N of M" progress readout while training. */
  plannedEpochs?: number;
  /** Overall step progress, 0–1 (the orchestrator's estimate) — the general "how far along" the run is. */
  progress?: number;
  /** The currently-training epoch's tail-able trace stream (step progress + logs), when tracing is on.
   *  Absent unless a run is mid-epoch. */
  liveTraceUrl?: string;
  /** Every epoch's trace, in epoch order. Empty when the run didn't request tracing. */
  traces: EpochTrace[];
  /** Only epochs that have actually produced content (a sample or downloadable weights). A still-training
   *  run's not-yet-produced epochs are excluded, so the page shows a processing state rather than empty cards. */
  epochs: TrainingDetailEpoch[];
  /** The images the run trained on, with their captions. Empty for runs whose dataset isn't blob-backed. */
  dataset: DatasetItem[];
  /** "Train further" lineage (see TrainingStudioMeta): the run this one continued from, when known. */
  sourceWorkflowId?: string;
  sourceEpoch?: number;
  /** The run's model on Civitai — draft or published (see TrainingStudioMeta.modelId); drives the
   *  model-page link. */
  modelId?: number;
  settings: TrainingSettingsExport;
}

/** Map one workflow (fetched by id) to the detail screen's shape. Null if we can't place it. */
export function workflowToDetail(w: Workflow): TrainingDetail | null {
  if (!w.id || w.tags?.includes(AUTO_LABEL_TAG)) return null;
  const { meta, input, state, output, media, base, code, name, progress, startedAt, completedAt } =
    resolveWorkflow(w);
  if (!state) return null;

  const prompts = input.samples?.prompts ?? output.sampleImagesPrompts ?? [];
  // Number of image slots per epoch = the prompt count (each prompt yields one image). Fall back to the
  // widest observed sample array when a run carries no prompt list.
  const slots =
    prompts.length || Math.max(0, ...(output.epochs ?? []).map((e) => epochSamples(e).length));

  // Only epochs that produced content (epochHasOutput, the counters' predicate) — a just-started
  // run renders as a "training underway" state rather than N empty checkpoint cards.
  const epochs: TrainingDetailEpoch[] = (output.epochs ?? [])
    .filter(epochHasOutput)
    .map((e, idx) => {
      const raw = epochSamples(e);
      const model = epochModel(e);
      return {
        id: `${e.epochNumber ?? 'x'}-${idx}`,
        // Match the main-app publish/generate bridge's `?? -1` fallback so a (pathological) numberless
        // epoch resolves to the same key on both sides — otherwise the deep link's `epoch=0` misses the
        // server's `-1` and it silently targets a different checkpoint.
        number: e.epochNumber ?? -1,
        samples: Array.from({ length: slots }, (_, i) => {
          const s = raw[i];
          return s?.available && typeof s.url === 'string' ? s.url : null;
        }),
        modelUrl: model?.available && typeof model.url === 'string' ? model.url : undefined,
        modelKey: epochModelKey(model),
        sizeBytes: typeof model?.size === 'number' ? model.size : undefined,
      };
    });

  const traces: EpochTrace[] = [...(output.epochs ?? [])]
    .sort((a, b) => (a.epochNumber ?? Infinity) - (b.epochNumber ?? Infinity))
    .flatMap((e) =>
      typeof e.traceUrl === 'string' && e.traceUrl
        ? [{ epoch: e.epochNumber ?? -1, url: e.traceUrl, done: !!epochModel(e)?.available }]
        : []
    );
  const liveTraceUrl = traces[liveTraceIndex(traces)]?.url;

  const dataset: DatasetItem[] = (input.trainingData?.items ?? [])
    .filter(
      (i): i is { air: string; caption?: string } => typeof i.air === 'string' && i.air.length > 0
    )
    .map((i) => ({ air: i.air, caption: i.caption ?? '' }));

  const training: TrainingSettingsExport['training'] = {};
  for (const key of SETTINGS_INPUT_KEYS) {
    const value = input[key];
    if (value !== undefined && value !== null) (training as Record<string, unknown>)[key] = value;
  }
  const settings: TrainingSettingsExport = {
    workflowId: w.id,
    name,
    createdAt: w.createdAt,
    media,
    ...(typeof meta.loraType === 'string' ? { loraType: meta.loraType } : {}),
    ...(typeof meta.cardType === 'string' ? { cardType: meta.cardType } : {}),
    ...(typeof meta.versionKey === 'string' ? { versionKey: meta.versionKey } : {}),
    imageCount: dataset.length || (typeof meta.imageCount === 'number' ? meta.imageCount : 0),
    samplePrompts: prompts,
    training,
  };

  return {
    workflowId: w.id,
    name,
    base,
    code,
    state,
    createdAt: w.createdAt,
    startedAt,
    completedAt,
    ecosystem: typeof input.ecosystem === 'string' && input.ecosystem ? input.ecosystem : undefined,
    media,
    isVideo: media === 'video',
    prompts,
    plannedEpochs: input.epochs ?? undefined,
    progress,
    liveTraceUrl,
    traces,
    epochs,
    dataset,
    sourceWorkflowId:
      typeof meta.sourceWorkflowId === 'string' && meta.sourceWorkflowId
        ? meta.sourceWorkflowId
        : undefined,
    sourceEpoch: typeof meta.sourceEpoch === 'number' ? meta.sourceEpoch : undefined,
    modelId: typeof meta.modelId === 'number' ? meta.modelId : undefined,
    settings,
  };
}

const blobExt = (id: string, fallback: string): string => {
  const dot = id.lastIndexOf('.');
  return dot > 0 ? id.slice(dot) : fallback;
};

/** The orchestrator rejects a blobArchive step with more entries than this. */
export const MAX_ARCHIVE_ENTRIES = 1000;

/** The blob entries for a run's "download all" archive: every epoch's weights first, then each
 *  epoch's samples, ascending by epoch — the order decides what survives when a run exceeds
 *  `MAX_ARCHIVE_ENTRIES`, and the weights are the part a user can't regenerate. Deduped by blob id.
 *  Legacy runs whose epochs carry only signed URLs (no blob ids) contribute nothing. */
export function epochArchiveEntries(w: Workflow): {
  entries: { blobId: string; fileName: string }[];
  archiveName: string;
} {
  const { output, name } = resolveWorkflow(w);
  // Flat names (`<run>-epoch-03.safetensors`, `<run>-epoch-03-sample-2.png`): the orchestrator
  // strips path components from entry names.
  const slug = slugify(name, 'training');
  const epochs = [...(output.epochs ?? [])].sort(
    (a, b) => (a.epochNumber ?? 0) - (b.epochNumber ?? 0)
  );
  const width = Math.max(2, String(epochs.at(-1)?.epochNumber ?? 0).length);
  const tag = (e: TrainingEpochOutput) => String(e.epochNumber ?? 0).padStart(width, '0');
  const entries: { blobId: string; fileName: string }[] = [];
  const seen = new Set<string>();
  const add = (blobId: string, fileName: string) => {
    if (seen.has(blobId) || entries.length >= MAX_ARCHIVE_ENTRIES) return;
    seen.add(blobId);
    entries.push({ blobId, fileName });
  };
  for (const e of epochs) {
    const key = epochModelKey(e.model);
    if (key) add(key, `${slug}-epoch-${tag(e)}${blobExt(key, '.safetensors')}`);
  }
  for (const e of epochs) {
    epochSamples(e).forEach((sample, i) => {
      if (!sample.available || typeof sample.id !== 'string' || !sample.id) return;
      add(sample.id, `${slug}-epoch-${tag(e)}-sample-${i + 1}${blobExt(sample.id, '')}`);
    });
  }
  return { entries, archiveName: `${slug}-checkpoints.zip` };
}

/** Preview rows for the dev-login user (id 0), who has no real orchestrator token. */
export const SAMPLE_ROWS: TrainingRow[] = [
  {
    name: 'my_character',
    base: 'Flux · Dev',
    baseFamily: 'Flux',
    code: 'FL',
    state: 'ready',
    sub: `${mediaCount(12, 'image')} · character`,
    progressPct: 0,
    progress: '',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
    hasModel: false,
  },
  {
    name: 'ink_wash_style',
    base: 'SDXL · Standard',
    baseFamily: 'SDXL',
    code: 'XL',
    state: 'training',
    sub: `${mediaCount(28, 'image')} · style`,
    progressPct: 62,
    progress: 'step 5,120 / 8,400 · checkpoint 6/10',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
    hasModel: false,
  },
  {
    name: 'chibi_pack',
    base: 'SDXL · Pony',
    baseFamily: 'SDXL',
    code: 'XL',
    state: 'published',
    sub: `${mediaCount(40, 'image')} · 1.2k downloads`,
    progressPct: 0,
    progress: '',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
    hasModel: true,
  },
  {
    name: 'retro_poster',
    base: 'SDXL · Illustrious',
    baseFamily: 'SDXL',
    code: 'XL',
    state: 'failed',
    sub: 'refunded ⚡ 1,750',
    progressPct: 0,
    progress: '',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
    hasModel: false,
  },
];

/** A finished-run detail for the dev-login preview (which has no real token to fetch one). */
export const SAMPLE_DETAIL: TrainingDetail = {
  workflowId: 'preview',
  name: 'my_character',
  base: 'SDXL · Standard',
  code: 'XL',
  state: 'ready',
  createdAt: '2026-08-21T16:48:19.000Z',
  startedAt: '2026-08-21T16:50:02.000Z',
  completedAt: '2026-08-21T17:34:40.000Z',
  ecosystem: 'sdxl',
  media: 'image',
  isVideo: false,
  prompts: [
    '1girl, solo, blue eyes, long silver hair, standing in a sunlit forest, detailed background',
    '1girl, close-up portrait, soft studio lighting, neutral expression, freckles',
    '1girl, full body, dynamic pose, city street at night, neon reflections',
  ],
  // The standard 3 samples per epoch, index-aligned to the prompts above. Epoch 8 drops its middle image
  // to exercise the missing-slot path.
  epochs: [4, 6, 8, 10].map((n, idx) => ({
    id: `${n}-${idx}`,
    number: n,
    samples: [0, 1, 2].map((i) =>
      n === 8 && i === 1 ? null : `https://picsum.photos/seed/ts-${n}-${i}/400`
    ),
    modelUrl: '#',
    modelKey: `preview-epoch-${n}`,
    sizeBytes: 36_000_000 + n * 1024,
  })),
  traces: [],
  // Preview dataset: picsum stand-ins keyed to bogus airs (the proxy is never hit in dev preview).
  dataset: [0, 1, 2, 3, 4, 5].map((i) => ({
    air: `https://picsum.photos/seed/ts-ds-${i}/300`,
    caption: `1girl, sample tag ${i + 1}, studio lighting`,
  })),
  settings: {
    workflowId: 'preview',
    name: 'my_character',
    createdAt: '2026-08-21T16:48:19.000Z',
    media: 'image',
    loraType: 'character',
    cardType: 'sdxl',
    versionKey: 'sdxl',
    imageCount: 6,
    samplePrompts: [],
    training: {
      engine: 'ai-toolkit',
      ecosystem: 'sdxl',
      steps: 2000,
      epochs: 10,
      batchSize: 4,
      lr: 5e-4,
      textEncoderLr: 5e-5,
      trainTextEncoder: true,
      lrScheduler: 'cosine',
      optimizerType: 'adafactor',
      networkDim: 32,
      networkAlpha: 32,
      resolution: 1024,
      triggerWord: 'my_character',
    },
  },
};
