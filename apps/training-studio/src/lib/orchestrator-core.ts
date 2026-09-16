// Client-safe orchestrator reads: everything here takes an already-built SDK client, so it runs
// in the browser (the web-component build) as well as in the shell's server routes, which wrap
// these with an env-configured client (lib/server/orchestrator.ts).
import {
  createCivitaiClient,
  getConsumerBlobUploadUrl,
  getWorkflow,
  queryWorkflows,
  submitWorkflow,
  type BuzzClientAccount,
  type WorkflowStepTemplate,
} from '@civitai/client';
import {
  CIVITAI_TAG,
  TRAINING_TAG,
  workflowToDetail,
  workflowToRow,
  type GenerationItem,
  type TrainingDetail,
  type TrainingRow,
} from '$lib/data/trainingRows';
import type { Media } from '$lib/data/trainingModels';

export type OrchestratorClient = ReturnType<typeof createCivitaiClient>;

/** Days of history the reconnect list pulls — matches the main app's 30-day workflow retention. */
export const RETENTION_DAYS = 30;

/** Flux.2 engines train through the `imageResourceTraining` step; everything else uses ai-toolkit
 *  `training`. The whatif quote and the real submit MUST agree on this branch, so it lives in one place. */
export function isFlux2(engine?: string): boolean {
  return engine === 'flux2-dev' || engine === 'flux2-dev-edit';
}

/** A rejected step comes back as RFC-9110 ProblemDetails (`.title` + a `.errors` field→messages map), a
 *  plain error as `.detail`; surface whichever is present, including the per-field validation errors so a
 *  bad body says which field, not just "One or more validation errors occurred". */
export function describeSubmitError(error: unknown): string {
  if (typeof error === 'string') return error;
  const e = error as
    | { detail?: string; title?: string; errors?: Record<string, string[] | string> }
    | undefined;
  if (e?.errors && typeof e.errors === 'object') {
    const fields = Object.entries(e.errors)
      .map(([key, val]) => `${key}: ${Array.isArray(val) ? val.join('; ') : val}`)
      .join(' | ');
    if (fields) return `${e.title ?? 'validation failed'} — ${fields}`;
  }
  return e?.detail ?? e?.title ?? 'no data returned';
}

/** Reduce a dataset `air` to the blob id the consumer endpoint wants. Three stored forms: an uploaded blob
 *  is an AIR URN (`urn:air:…:blob@<key>` — the key is after `@`); a generation is a full
 *  `/v2/consumer/blobs/{key}.ext` URL (the key is the last path segment); anything else is already a bare
 *  key. Query/signature is stripped in every case. */
function blobIdFromAir(air: string): string {
  const marker = '/v2/consumer/blobs/';
  const idx = air.indexOf(marker);
  if (idx >= 0) return air.slice(idx + marker.length).split('?')[0];
  if (air.startsWith('urn:air:')) return (air.split('@').pop() ?? air).split('?')[0];
  return air.split('?')[0];
}

/** The orchestrator's authenticated GET URL for one of the caller's dataset blobs (fetch with
 *  `Authorization: Bearer <token>`). Shared by the shell's proxy route and the element's direct fetch. */
export function consumerBlobUrl(endpoint: string, air: string, workflowId?: string): string {
  const base = endpoint.replace(/\/+$/, '');
  const blobId = encodeURIComponent(blobIdFromAir(air));
  return `${base}/v2/consumer/blobs/${blobId}${
    workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
  }`;
}

/** The caller's training runs from the orchestrator, newest first, mapped to list rows. */
export async function listTrainingWorkflows(client: OrchestratorClient): Promise<TrainingRow[]> {
  const fromDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await queryWorkflows({
    client,
    query: { tags: [CIVITAI_TAG, TRAINING_TAG], take: 100, fromDate, hideMatureContent: false },
  });
  if (!data) throw new Error(`queryWorkflows failed: ${error?.detail ?? 'no data returned'}`);
  return (data.items ?? []).map(workflowToRow).filter((r): r is TrainingRow => r !== null);
}

const GENERATION_TAG = 'gen';
const MEDIA_TAG: Record<Media, string> = { image: 'img', video: 'vid', audio: 'aud' };
/** A picker grid caps out well before this; enough to cover a heavy day of generations. */
const MAX_GENERATION_ITEMS = 200;

/** One output blob off a raw workflow step, across all media shapes (image/video/audio). */
interface OutputBlob {
  id: string;
  available: boolean;
  url?: string | null;
  previewUrl?: string | null;
  blockedReason?: string | null;
  type?: string;
}
interface RawStep {
  $type?: string;
  output?: {
    blobs?: OutputBlob[];
    images?: OutputBlob[];
    blob?: OutputBlob | null;
    video?: OutputBlob | null;
    additionalVideos?: OutputBlob[] | null;
  };
}

// The orchestrator's queryGeneratedImages feed normalizes step outputs SERVER-SIDE, so its clients read a
// flat `step.images`. We call the raw SDK queryWorkflows, which returns un-normalized steps, so we mirror
// the relevant branches of the main app's `normalizeStepOutput`: which output field holds the media
// depends on the step `$type` (`comfy`→blobs, `textToImage`/`imageGen`→images, upscalers→blob, …).
function stepBlobsForMedia(step: RawStep, media: Media): OutputBlob[] {
  const output = step.output;
  if (!output) return [];
  const arr = (v: OutputBlob[] | null | undefined) => v ?? [];
  const one = (v: OutputBlob | null | undefined) => (v ? [v] : []);

  if (media === 'image') {
    switch (step.$type) {
      case 'comfy':
        return arr(output.blobs);
      case 'imageGen':
      case 'textToImage':
      case 'model3DPreview':
        return arr(output.images);
      case 'imageUpscaler':
      case 'preprocessImage':
        return one(output.blob);
      default:
        return [];
    }
  }
  if (media === 'video') {
    switch (step.$type) {
      case 'videoGen':
        return [...one(output.video), ...arr(output.additionalVideos)];
      case 'videoUpscaler':
      case 'videoEnhancement':
      case 'videoInterpolation':
        return one(output.video);
      default:
        return [];
    }
  }
  // audio: aceStepAudio emits a VideoBlob (audio + cover) or an AudioBlob — only the latter is trainable audio.
  if (step.$type === 'aceStepAudio' && output.blob?.type === 'audio') return one(output.blob);
  return [];
}

/** The caller's recent generated media of one type, as pick-able blobs — pulled from their generation
 *  workflows (tagged civitai/gen/<media>), taking each step's available, unblocked output blobs. The URL
 *  is presigned and short-lived: the picker uses it for previews, and the dataset is seeded by blob id
 *  (already scanned, so `addFromBlobs` skips upload). */
export async function listGenerations(
  client: OrchestratorClient,
  media: Media
): Promise<GenerationItem[]> {
  const fromDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await queryWorkflows({
    client,
    query: {
      tags: [CIVITAI_TAG, GENERATION_TAG, MEDIA_TAG[media]],
      take: 100,
      fromDate,
      hideMatureContent: false,
    },
  });
  if (!data) throw new Error(`queryWorkflows failed: ${error?.detail ?? 'no data returned'}`);

  const items: GenerationItem[] = [];
  const seen = new Set<string>();
  for (const workflow of data.items ?? []) {
    for (const step of (workflow.steps ?? []) as RawStep[]) {
      for (const blob of stepBlobsForMedia(step, media)) {
        if (blob.available && !blob.blockedReason && blob.url && !seen.has(blob.id)) {
          seen.add(blob.id);
          items.push({ blobId: blob.id, url: blob.url, previewUrl: blob.previewUrl ?? blob.url });
        }
      }
    }
    if (items.length >= MAX_GENERATION_ITEMS) break;
  }
  return items.slice(0, MAX_GENERATION_ITEMS);
}

/** A representative dataset size for a pre-dataset "from" quote. Under step-based pricing the image count
 * barely moves the estimate — steps (omitted here, so the orchestrator uses the ecosystem's default) drive
 * it — so any plausible count works. */
const WHATIF_IMAGE_COUNT = 20;
// License fees are only priced when a run generates samples, so a whatif must always carry non-empty
// prompts or the estimate silently drops the fee the real submission incurs (mirrors the main app).
const WHATIF_SAMPLE_PROMPTS = ['sample prompt', 'sample prompt', 'sample prompt'];
// Which Buzz wallets may pay — the standard user spend set. It gates the payment source, not the price,
// so the estimated total is the same for any non-empty set; required on the workflow body regardless.
const WHATIF_CURRENCIES: BuzzClientAccount[] = ['yellow', 'blue'];

export interface TrainingWhatIfInput {
  ecosystem: string;
  modelVariant?: string;
  /** The base checkpoint AIR — required by the `flux2-dev` path; unused by ai-toolkit (its ecosystem
   * resolves the base). */
  model?: string;
  /** Non-default engine (e.g. `flux2-dev`); when set the whatif uses the `imageResourceTraining` shape. */
  engine?: string;
  /** Ecosystem-specific version selector (e.g. the `qwen` ecosystem's `version` field). */
  version?: string;
  /** Omit for the "from" floor — the orchestrator then prices its per-ecosystem default step budget. */
  steps?: number;
  imageCount?: number;
}

// Representative defaults for the `imageResourceTraining` (flux2-dev) path — that schema requires an
// epoch/repeat/resolution budget rather than deriving one, so a "from" quote uses a modest fixed config.
const WHATIF_FLUX2 = { resolution: 1024, maxTrainEpochs: 10, numRepeats: 200, trainBatchSize: 1 };

/** Price a training run without submitting it (`whatif`). Most models use the ai-toolkit path (its
 * ecosystem resolves the base); a few (Flux.2) have no ai-toolkit ecosystem and train via `flux2-dev`,
 * priced through the `imageResourceTraining` shape with an explicit base AIR. Returns the total Buzz cost,
 * or null if the orchestrator returned no estimate. No real dataset is needed — the URL is never fetched. */
export async function trainingWhatIf(
  client: OrchestratorClient,
  input: TrainingWhatIfInput
): Promise<number | null> {
  const count = input.imageCount ?? WHATIF_IMAGE_COUNT;
  // The SDK type marks server-computed fields (defaultSteps, usesStepPricing, …) as required outputs we
  // must not send; cast past them, as the main app's training step builders do.
  const step = (isFlux2(input.engine)
    ? {
        $type: 'imageResourceTraining',
        priority: 'normal',
        input: {
          loraName: '',
          model: input.model,
          trainingData: 'https://fake',
          trainingDataImagesCount: count,
          samplePrompts: WHATIF_SAMPLE_PROMPTS,
          negativePrompt: '',
          engine: input.engine,
          ...WHATIF_FLUX2,
        },
      }
    : {
        $type: 'training',
        priority: 'normal',
        input: {
          engine: 'ai-toolkit',
          ecosystem: input.ecosystem,
          ...(input.modelVariant ? { modelVariant: input.modelVariant } : {}),
          ...(input.version ? { version: input.version } : {}),
          trainingData: { type: 'zip', sourceUrl: 'https://fake', count },
          samples: { prompts: WHATIF_SAMPLE_PROMPTS },
          ...(input.steps ? { steps: input.steps } : {}),
        },
      }) as unknown as WorkflowStepTemplate;

  const { data, error } = await submitWorkflow({
    client,
    body: { steps: [step], currencies: WHATIF_CURRENCIES },
    query: { whatif: true },
  });
  if (!data) throw new Error(`training whatif failed: ${describeSubmitError(error)}`);
  return data.cost?.total ?? null;
}

/** Mint a short-lived presigned URL for a single dataset blob. The browser POSTs the file straight to
 *  `uploadUrl` (offloading the bytes from us); that POST scans the media and returns the registered blob.
 *  One URL per file, as the main app's per-image upload does. */
export async function blobUploadUrl(
  client: OrchestratorClient
): Promise<{ uploadUrl: string; expiresAt: string }> {
  const { data, error } = await getConsumerBlobUploadUrl({ client });
  if (!data) throw new Error(`blob upload url failed: ${error?.detail ?? 'no data returned'}`);
  return { uploadUrl: data.uploadUrl, expiresAt: data.expiresAt };
}

/** One training run's detail (the Open screen), or null if it's gone / not the caller's / not mappable. */
export async function getTrainingWorkflow(
  client: OrchestratorClient,
  workflowId: string
): Promise<TrainingDetail | null> {
  const { data, error } = await getWorkflow({ client, path: { workflowId } });
  if (!data) {
    if (error?.status === 404) return null;
    throw new Error(`getWorkflow failed: ${error?.detail ?? 'no data returned'}`);
  }
  return workflowToDetail(data);
}

/** A run's dataset (blob airs + captions) — for Remix / "reuse a dataset". Empty for a run whose dataset
 *  isn't blob-backed (older or Flux.2). The token scopes to the caller, so this only reads their own runs. */
export async function getRunDataset(
  client: OrchestratorClient,
  workflowId: string
): Promise<{ air: string; caption: string }[]> {
  const detail = await getTrainingWorkflow(client, workflowId);
  return detail?.dataset ?? [];
}
