import { submitWorkflow, type BuzzClientAccount, type WorkflowStepTemplate } from '@civitai/client';
import { isFlux2, orchestratorClient } from './orchestrator';
import {
  CIVITAI_TAG,
  META_VERSION,
  TRAINING_TAG,
  type TrainingStudioMeta,
} from '$lib/data/trainingRows';

/** One dataset item: the uploaded blob (a bare key, blobs URL, or AIR — normalized at submission) plus
 *  its label. The trigger word is applied separately via `triggerWord`, so captions here are raw. */
export interface TrainingItem {
  air: string;
  caption: string;
}

/** Everything the client assembles for one training run. Params arrive as the numbers the orchestrator
 *  wants (the Review step's string inputs are parsed client-side). */
export interface TrainingRunInput {
  ecosystem: string;
  modelVariant?: string;
  /** Ecosystem version selector (e.g. qwen's `version`). */
  version?: string;
  /** Non-default engine (Flux.2 = `flux2-dev`); when set, the run uses the imageResourceTraining shape. */
  engine?: string;
  /** Base checkpoint AIR — required by the flux2 path. */
  model?: string;
  steps: number;
  epochs: number;
  unetLr: number;
  textEncoderLr: number;
  networkDim: number;
  networkAlpha: number;
  resolution: number;
  batchSize: number;
  lrScheduler: string;
  optimizer: string;
  trigger: string;
  items: TrainingItem[];
  prompts: string[];
  meta: TrainingStudioMeta;
}

// Real-spend wallets (Buzz), same set the whatif quotes against.
const CURRENCIES: BuzzClientAccount[] = ['yellow', 'blue'];

/** Build one run's training step. Both shapes carry the dataset as a blob list (the orchestrator accepts
 *  blobs for every engine; the SDK types imageResourceTraining's `trainingData` as a string, so that path
 *  is cast). The Flux.2 (imageResourceTraining) engine takes no hyperparameters — only the base model +
 *  data + prompts, matching the main app. Ai-toolkit's hyperparameters are sent as extra input fields the
 *  minimal SDK type doesn't declare — the same cast-past-the-type the whatif and the main app's builders use. */
function buildStep(run: TrainingRunInput): WorkflowStepTemplate {
  const trainingData = { type: 'blobs', items: run.items };
  const optimizerType = run.optimizer.toLowerCase();

  const step = isFlux2(run.engine)
    ? {
        $type: 'imageResourceTraining',
        priority: 'normal',
        input: {
          engine: run.engine,
          model: run.model,
          loraName: run.trigger || run.meta.name || 'lora',
          trainingData,
          trainingDataImagesCount: run.items.length,
          samplePrompts: run.prompts,
          negativePrompt: '',
        },
      }
    : {
        $type: 'training',
        priority: 'normal',
        input: {
          engine: 'ai-toolkit',
          ecosystem: run.ecosystem,
          ...(run.modelVariant ? { modelVariant: run.modelVariant } : {}),
          ...(run.version ? { version: run.version } : {}),
          steps: run.steps,
          epochs: run.epochs,
          batchSize: run.batchSize,
          lr: run.unetLr,
          textEncoderLr: run.textEncoderLr,
          trainTextEncoder: run.textEncoderLr > 0,
          lrScheduler: run.lrScheduler,
          optimizerType,
          networkDim: run.networkDim,
          networkAlpha: run.networkAlpha,
          resolution: run.resolution,
          triggerWord: run.trigger,
          trainingData,
          samples: { prompts: run.prompts },
        },
      };

  return step as unknown as WorkflowStepTemplate;
}

/** A rejected step comes back as RFC-9110 ProblemDetails (`.title` + `.errors`), a plain error as
 *  `.detail`; surface whichever is present. */
function describeSubmitError(error: unknown): string {
  if (typeof error === 'string') return error;
  const e = error as { detail?: string; title?: string } | undefined;
  return e?.detail ?? e?.title ?? 'no data returned';
}

/** Submit one real training workflow; returns its id. Charges Buzz. A whatif preflight validates the exact
 *  step first, so a bad field shape (or a Flux.2-blobs rejection) fails with ZERO spend rather than after
 *  the real submit has already charged. */
export async function submitTraining(token: string, run: TrainingRunInput): Promise<string> {
  const client = orchestratorClient(token);
  const metadata: TrainingStudioMeta = { ...run.meta, v: META_VERSION };
  const body = {
    tags: [CIVITAI_TAG, TRAINING_TAG],
    metadata: metadata as Record<string, unknown>,
    steps: [buildStep(run)],
    currencies: CURRENCIES,
  };

  // Preflight: prices the exact step without executing/charging. A rejection here means the real submit
  // would fail too — surface it before any Buzz moves.
  const preflight = await submitWorkflow({ client, body, query: { whatif: true } });
  if (!preflight.data) {
    throw new Error(`training preflight failed: ${describeSubmitError(preflight.error)}`);
  }

  const { data, error } = await submitWorkflow({ client, body, query: { wait: 0 } });
  if (!data?.id) throw new Error(`training submit failed: ${describeSubmitError(error)}`);
  return data.id;
}
