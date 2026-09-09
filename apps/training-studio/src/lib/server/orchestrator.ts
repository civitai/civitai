import {
  createCivitaiClient,
  getConsumerBlobUploadUrl,
  getWorkflow,
  queryWorkflows,
  submitWorkflow,
  type BuzzClientAccount,
  type WorkflowStepTemplate,
} from '@civitai/client';
import { env } from '$env/dynamic/private';
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

/** Days of history the reconnect list pulls — matches the main app's 30-day workflow retention. */
const RETENTION_DAYS = 30;

/** Flux.2 engines train through the `imageResourceTraining` step; everything else uses ai-toolkit
 *  `training`. The whatif quote and the real submit MUST agree on this branch, so it lives in one place. */
export function isFlux2(engine?: string): boolean {
  return engine === 'flux2-dev' || engine === 'flux2-dev-edit';
}

export function orchestratorClient(token: string) {
  return createCivitaiClient({
    baseUrl: env.ORCHESTRATOR_ENDPOINT,
    env: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: token,
  });
}

/** The caller's training runs from the orchestrator, newest first, mapped to list rows. */
export async function listTrainingWorkflows(token: string): Promise<TrainingRow[]> {
  const fromDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await queryWorkflows({
    client: orchestratorClient(token),
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
export async function listGenerations(token: string, media: Media): Promise<GenerationItem[]> {
  const fromDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await queryWorkflows({
    client: orchestratorClient(token),
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
  token: string,
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
    client: orchestratorClient(token),
    body: { steps: [step], currencies: WHATIF_CURRENCIES },
    query: { whatif: true },
  });
  if (!data) {
    // A rejected step comes back as an RFC-9110 ProblemDetails (`.title` + `.errors`), not `.detail`, so
    // surface `.title` — otherwise a validation 400 logs as an unhelpful "no data returned".
    const detail =
      typeof error === 'string' ? error : error?.detail ?? error?.title ?? 'no data returned';
    throw new Error(`training whatif failed: ${detail}`);
  }
  return data.cost?.total ?? null;
}

/** Mint a short-lived presigned URL for a single dataset blob. The browser POSTs the file straight to
 *  `uploadUrl` (offloading the bytes from us); that POST scans the media and returns the registered blob.
 *  One URL per file, as the main app's per-image upload does. */
export async function blobUploadUrl(
  token: string
): Promise<{ uploadUrl: string; expiresAt: string }> {
  const { data, error } = await getConsumerBlobUploadUrl({ client: orchestratorClient(token) });
  if (!data) throw new Error(`blob upload url failed: ${error?.detail ?? 'no data returned'}`);
  return { uploadUrl: data.uploadUrl, expiresAt: data.expiresAt };
}

/** One training run's detail (the Open screen), or null if it's gone / not the caller's / not mappable. */
export async function getTrainingWorkflow(
  token: string,
  workflowId: string
): Promise<TrainingDetail | null> {
  const { data, error } = await getWorkflow({
    client: orchestratorClient(token),
    path: { workflowId },
  });
  if (!data) {
    if (error?.status === 404) return null;
    throw new Error(`getWorkflow failed: ${error?.detail ?? 'no data returned'}`);
  }
  return workflowToDetail(data);
}

/** A run's dataset (blob airs + captions) — for Remix / "reuse a dataset". Empty for a run whose dataset
 *  isn't blob-backed (older or Flux.2). The token scopes to the caller, so this only reads their own runs. */
export async function getRunDataset(
  token: string,
  workflowId: string
): Promise<{ air: string; caption: string }[]> {
  const detail = await getTrainingWorkflow(token, workflowId);
  return detail?.dataset ?? [];
}
