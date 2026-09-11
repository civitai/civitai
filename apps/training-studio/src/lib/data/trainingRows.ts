import type { Workflow, WorkflowStatus } from '@civitai/client';
import { cardByEcosystem, cardByType, findByAir, type Media } from './trainingModels';

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
  published: { label: 'Published', cls: 'text-buzz bg-buzz/15', dot: 'bg-buzz' },
  failed: { label: 'Failed', cls: 'text-red-400 bg-red-500/15', dot: 'bg-red-400' },
};

export interface TrainingRow {
  /** Orchestrator workflow id — the handle for reconnect/open. Absent only for sample rows. */
  workflowId?: string;
  name: string;
  base: string;
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

/** The fields we read off the workflow's `training` step. Read defensively — @civitai/client types
 * `steps[].input/output` loosely, and a foreign/older workflow may not carry all of them. */
interface TrainingStepInput {
  model?: string;
  ecosystem?: string;
  epochs?: number;
  steps?: number;
  triggerWord?: string;
  /** The fixed sample prompts (usually 3). Each epoch generates one image per prompt, positionally. */
  samples?: { prompts?: string[] };
  /** The dataset the run trained on — blob-backed items (a blob `air`/key + its caption). Older or Flux.2
   *  runs may carry a zip URL instead, in which case there are no per-image items to show. */
  trainingData?: { type?: string; items?: Array<{ air?: string; caption?: string }> };
}
interface TrainingStepOutput {
  epochs?: Array<{
    epochNumber?: number;
    model?: { url?: string | null; available?: boolean };
    samples?: Array<{ url?: string | null; available?: boolean }>;
    /** Tail-able live trace of this epoch's job (present only when the run requested tracing). */
    traceUrl?: string | null;
  }>;
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

  const step = w.steps?.find((s) => (s as { $type?: string }).$type === 'training') ?? w.steps?.[0];
  const input = ((step as { input?: TrainingStepInput } | undefined)?.input ??
    {}) as TrainingStepInput;
  const output = ((step as { output?: TrainingStepOutput } | undefined)?.output ??
    {}) as TrainingStepOutput;
  // The orchestrator's 0–1 estimate of overall step progress (refreshed on each job event); the general
  // "how far along" the run is, independent of the per-epoch checkpoints.
  const rate = (step as { estimatedProgressRate?: number | null } | undefined)
    ?.estimatedProgressRate;
  const progress = typeof rate === 'number' ? Math.max(0, Math.min(1, rate)) : undefined;

  // Base model: the exact `air` the run trained on, else its ecosystem, else our metadata's card type.
  const byAir = input.model ? findByAir(input.model) : undefined;
  const card =
    byAir?.card ??
    (input.ecosystem ? cardByEcosystem(input.ecosystem) : undefined) ??
    (meta.cardType ? cardByType(meta.cardType) : undefined);
  const version = byAir?.version ?? card?.versions.find((v) => v.key === meta.versionKey);

  return {
    meta,
    state,
    input,
    output,
    progress,
    media: card?.media ?? 'image',
    base: card ? `${card.name}${version ? ` · ${version.label}` : ''}` : 'Training run',
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

/** Epochs that have produced something (a finished checkpoint or a sample) — the "N complete" count. */
function completedEpochCount(epochs: TrainingStepOutput['epochs']): number {
  return (epochs ?? []).filter(
    (e) =>
      (e.model?.available && e.model?.url) || (e.samples ?? []).some((s) => s.available && s.url)
  ).length;
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
    code,
    name,
    media,
    progress: progressRate,
  } = resolveWorkflow(w);
  if (!state) return null;

  const epochCount = output.epochs?.length ?? input.epochs;
  const parts: string[] = [];
  if (typeof meta.imageCount === 'number') parts.push(`${meta.imageCount} images`);
  if (epochCount) parts.push(`${epochCount} epochs`);
  if (meta.loraType) parts.push(meta.loraType);

  // Thumbnails: up to 4 sample images, newest epoch first (only `available` blobs carry a URL). A single
  // epoch often has fewer than 4, so we fill from the most recent epochs backward.
  const sampleUrls: string[] = [];
  for (const epoch of [...(output.epochs ?? [])].reverse()) {
    for (const s of epoch.samples ?? []) {
      if (sampleUrls.length >= 4) break;
      if (s.available && typeof s.url === 'string') sampleUrls.push(s.url);
    }
    if (sampleUrls.length >= 4) break;
  }

  const completedEpochs = completedEpochCount(output.epochs);
  // The epoch being worked on now = one past the last completed, capped at the plan.
  const currentEpoch = input.epochs
    ? Math.min(completedEpochs + 1, input.epochs)
    : completedEpochs + 1;

  return {
    workflowId: w.id,
    name,
    base,
    code,
    state,
    sub: parts.join(' · '),
    progressPct: overallProgressPct(completedEpochs, input.epochs, progressRate),
    progress:
      state === 'training'
        ? input.epochs
          ? `epoch ${currentEpoch} / ${input.epochs}`
          : w.status
        : '',
    sampleUrls,
    media,
    isVideo: media === 'video',
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
}

/** One dataset image the run trained on: the blob reference (resolved to a viewable URL through the
 *  dataset-blob proxy) and the caption/tags it was labeled with. */
export interface DatasetItem {
  air: string;
  caption: string;
}

/** A single training run's detail, for the Open screen. */
export interface TrainingDetail {
  workflowId: string;
  name: string;
  base: string;
  code: string;
  state: RunState;
  createdAt: string;
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
  /** Only epochs that have actually produced content (a sample or downloadable weights). A still-training
   *  run's not-yet-produced epochs are excluded, so the page shows a processing state rather than empty cards. */
  epochs: TrainingDetailEpoch[];
  /** The images the run trained on, with their captions. Empty for runs whose dataset isn't blob-backed. */
  dataset: DatasetItem[];
  /** "Train further" lineage (see TrainingStudioMeta): the run this one continued from, when known. */
  sourceWorkflowId?: string;
  sourceEpoch?: number;
}

/** Map one workflow (fetched by id) to the detail screen's shape. Null if we can't place it. */
export function workflowToDetail(w: Workflow): TrainingDetail | null {
  if (!w.id || w.tags?.includes(AUTO_LABEL_TAG)) return null;
  const { meta, input, state, output, media, base, code, name, progress } = resolveWorkflow(w);
  if (!state) return null;

  const prompts = input.samples?.prompts ?? [];
  // Number of image slots per epoch = the prompt count (each prompt yields one image). Fall back to the
  // widest observed sample array when a run carries no prompt list.
  const slots =
    prompts.length || Math.max(0, ...(output.epochs ?? []).map((e) => e.samples?.length ?? 0));

  const epochs: TrainingDetailEpoch[] = (output.epochs ?? [])
    .map((e, idx) => {
      const raw = e.samples ?? [];
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
        modelUrl: e.model?.available && typeof e.model.url === 'string' ? e.model.url : undefined,
      };
    })
    // Drop epochs the orchestrator has listed but not yet produced (no sample, no weights) — otherwise a
    // just-started run renders as N empty checkpoints instead of a "training underway" state.
    .filter((e) => e.modelUrl != null || e.samples.some((s) => s !== null));

  // The live trace is the currently-training epoch's stream. The orchestrator pre-creates ALL epoch entries
  // up front, each with a traceUrl, and marks them done as weights land — so the epoch training *now* is the
  // LOWEST-numbered one without finished weights. (Picking the highest tailed the final epoch's stream, which
  // stays empty until the run is nearly over — the "blank until ~80%" bug.) Absent once every epoch is done.
  const liveTraceUrl = [...(output.epochs ?? [])]
    .filter((e) => typeof e.traceUrl === 'string' && !e.model?.available)
    .sort((a, b) => (a.epochNumber ?? Infinity) - (b.epochNumber ?? Infinity))[0]?.traceUrl;

  const dataset: DatasetItem[] = (input.trainingData?.items ?? [])
    .filter(
      (i): i is { air: string; caption?: string } => typeof i.air === 'string' && i.air.length > 0
    )
    .map((i) => ({ air: i.air, caption: i.caption ?? '' }));

  return {
    workflowId: w.id,
    name,
    base,
    code,
    state,
    createdAt: w.createdAt,
    media,
    isVideo: media === 'video',
    prompts,
    plannedEpochs: input.epochs,
    progress,
    liveTraceUrl: liveTraceUrl ?? undefined,
    epochs,
    dataset,
    sourceWorkflowId:
      typeof meta.sourceWorkflowId === 'string' && meta.sourceWorkflowId
        ? meta.sourceWorkflowId
        : undefined,
    sourceEpoch: typeof meta.sourceEpoch === 'number' ? meta.sourceEpoch : undefined,
  };
}

/** Preview rows for the dev-login user (id 0), who has no real orchestrator token. */
export const SAMPLE_ROWS: TrainingRow[] = [
  {
    name: 'my_character',
    base: 'Flux · Dev',
    code: 'FL',
    state: 'ready',
    sub: '12 images · character',
    progressPct: 0,
    progress: '',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
  },
  {
    name: 'ink_wash_style',
    base: 'SDXL · Standard',
    code: 'XL',
    state: 'training',
    sub: '28 images · style',
    progressPct: 62,
    progress: 'step 5,120 / 8,400 · checkpoint 6/10',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
  },
  {
    name: 'chibi_pack',
    base: 'SDXL · Pony',
    code: 'XL',
    state: 'published',
    sub: '40 images · 1.2k downloads',
    progressPct: 0,
    progress: '',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
  },
  {
    name: 'retro_poster',
    base: 'SDXL · Illustrious',
    code: 'XL',
    state: 'failed',
    sub: 'refunded ⚡ 1,750',
    progressPct: 0,
    progress: '',
    sampleUrls: [],
    media: 'image',
    isVideo: false,
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
  })),
  // Preview dataset: picsum stand-ins keyed to bogus airs (the proxy is never hit in dev preview).
  dataset: [0, 1, 2, 3, 4, 5].map((i) => ({
    air: `https://picsum.photos/seed/ts-ds-${i}/300`,
    caption: `1girl, sample tag ${i + 1}, studio lighting`,
  })),
};
