import {
  getWorkflow,
  submitWorkflow,
  updateWorkflow,
  type BuzzClientAccount,
  type WorkflowStepTemplate,
} from '@civitai/client';
import { env } from '$env/dynamic/private';
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
  /** Which Buzz accounts to charge, in priority order (the user's choice on Review). Validated + defaulted
   *  server-side — never trusted from the client body. */
  currencies?: string[];
  meta: TrainingStudioMeta;
}

// Real-spend wallets (Buzz), same set the whatif quotes against. Also the default when the client sends
// nothing valid.
const CURRENCIES: BuzzClientAccount[] = ['yellow', 'blue'];
// The Buzz accounts a training run may draw from — the client's `currencies` is filtered to this set so a
// tampered/garbage body can't send an arbitrary account to the orchestrator.
const ALLOWED_CURRENCIES: BuzzClientAccount[] = ['yellow', 'blue', 'green'];

function resolveCurrencies(input?: string[]): BuzzClientAccount[] {
  const picked = (input ?? []).filter((c): c is BuzzClientAccount =>
    ALLOWED_CURRENCIES.includes(c as BuzzClientAccount)
  );
  return picked.length ? picked : CURRENCIES;
}
// Opt each epoch job into an NDJSON live trace (step progress + console logs), exposed as
// `output.epochs[].traceUrl` (ai-toolkit only). OFF by default: sending this unknown field before the
// orchestrator's trace feature is live could get the whole submit rejected, so it's gated on an env flag —
// set TRAINING_TRACE_MODE=events (or logs) once the orchestrator side has shipped.
const TRACE_MODE = env.TRAINING_TRACE_MODE ?? 'none';

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
          ...(TRACE_MODE !== 'none' ? { trace: TRACE_MODE } : {}),
          trainingData,
          samples: { prompts: run.prompts },
        },
      };

  return step as unknown as WorkflowStepTemplate;
}

/** A rejected step comes back as RFC-9110 ProblemDetails (`.title` + a `.errors` field→messages map), a
 *  plain error as `.detail`; surface whichever is present, including the per-field validation errors so a
 *  bad body says which field, not just "One or more validation errors occurred". */
function describeSubmitError(error: unknown): string {
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

// The workflow carries the run name both as `metadata.name` (the displayed title) and a `name:<slug>` tag
// (for finding it). This prefix is the one place the tag shape is written and matched.
const NAME_TAG_PREFIX = 'name:';

/** A short tag-safe slug of the run name, so a training can be found by name later. */
function nameSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Submit one real training workflow; returns its id. Charges Buzz — the single write in the flow. */
export async function submitTraining(token: string, run: TrainingRunInput): Promise<string> {
  const metadata: TrainingStudioMeta = { ...run.meta, v: META_VERSION };
  const slug = run.meta.name ? nameSlug(run.meta.name) : '';
  const { data, error } = await submitWorkflow({
    client: orchestratorClient(token),
    body: {
      tags: slug
        ? [CIVITAI_TAG, TRAINING_TAG, `${NAME_TAG_PREFIX}${slug}`]
        : [CIVITAI_TAG, TRAINING_TAG],
      metadata: metadata as Record<string, unknown>,
      steps: [buildStep(run)],
      currencies: resolveCurrencies(run.currencies),
    },
    query: { wait: 0 },
  });
  if (!data?.id) throw new Error(`training submit failed: ${describeSubmitError(error)}`);
  return data.id;
}

/** Rename a training: merge the new name into the workflow metadata (the title the list/detail read) and
 *  swap its `name:<slug>` tag. Fetches current metadata/tags first so nothing else is dropped. Per-user —
 *  the token only resolves the caller's own workflows, so this can't rename someone else's. */
export async function renameTraining(
  token: string,
  workflowId: string,
  name: string
): Promise<void> {
  const client = orchestratorClient(token);
  const { data: current, error: getError } = await getWorkflow({ client, path: { workflowId } });
  if (!current) throw new Error(`rename: workflow not found (${describeSubmitError(getError)})`);

  const trimmed = name.trim();
  const metadata = { ...(current.metadata ?? {}), name: trimmed };
  const slug = trimmed ? nameSlug(trimmed) : '';
  const tags = [
    ...(current.tags ?? []).filter((t) => !t.startsWith(NAME_TAG_PREFIX)),
    ...(slug ? [`${NAME_TAG_PREFIX}${slug}`] : []),
  ];

  const { error } = await updateWorkflow({
    client,
    path: { workflowId },
    body: { metadata, tags },
  });
  if (error) throw new Error(`rename failed: ${describeSubmitError(error)}`);
}
