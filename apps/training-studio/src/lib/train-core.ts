// Client-safe training submit builders: pure body construction + SDK calls against a provided
// client. Env-derived concerns are parameters — the shell's server wrappers (lib/server/train.ts)
// pass the trace mode from env and the per-user signal callbacks; the web-component backend passes
// its host config and no callbacks.
import {
  Air,
  getWorkflow,
  submitWorkflow,
  updateWorkflow,
  type BuzzClientAccount,
  type WorkflowCallback,
  type WorkflowStepTemplate,
  type WorkflowTemplate,
} from '@civitai/client';
import { describeSubmitError, isFlux2, type OrchestratorClient } from './orchestrator-core';
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
  /** The `Custom…` base: a Civitai model AIR to train on, overriding the ecosystem's default base. */
  customModel?: string;
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
  /** A previous checkpoint's blob-reference AIR to continue training from ("keep training"); omit for fresh. */
  continueFrom?: string;
  /** Which Buzz accounts to charge, in priority order (the user's choice on Review). Validated + defaulted
   *  by `resolveCurrencies` — never trusted from the wire. */
  currencies?: string[];
  meta: TrainingStudioMeta;
}

/** Host-dependent submit knobs: the shell passes env trace mode + per-user signal callbacks; the
 *  element passes its host's trace mode and no callbacks. */
export interface SubmitOptions {
  callbacks?: WorkflowCallback[];
  /** Opt each epoch job into an NDJSON live trace (`events` or `logs`); `none` (the default) sends
   *  nothing — an unknown field on the submit could get the whole workflow rejected. */
  traceMode?: string;
}

// Real-spend wallets (Buzz), same set the whatif quotes against. Also the default when the client sends
// nothing valid.
const CURRENCIES: BuzzClientAccount[] = ['blue', 'yellow'];
// The Buzz accounts a training run may draw from — the caller's `currencies` is filtered to this set so a
// tampered/garbage body can't send an arbitrary account to the orchestrator.
const ALLOWED_CURRENCIES: BuzzClientAccount[] = ['yellow', 'blue', 'green'];

function resolveCurrencies(input?: string[]): BuzzClientAccount[] {
  const picked = (input ?? []).filter((c): c is BuzzClientAccount =>
    ALLOWED_CURRENCIES.includes(c as BuzzClientAccount)
  );
  return picked.length ? picked : CURRENCIES;
}

/** Build one run's training step. Both shapes carry the dataset as a blob list (the orchestrator accepts
 *  blobs for every engine; the SDK types imageResourceTraining's `trainingData` as a string, so that path
 *  is cast). The Flux.2 (imageResourceTraining) engine takes no hyperparameters — only the base model +
 *  data + prompts, matching the main app. Ai-toolkit's hyperparameters are sent as extra input fields the
 *  minimal SDK type doesn't declare — the same cast-past-the-type the whatif and the main app's builders use. */
function buildStep(run: TrainingRunInput, traceMode: string): WorkflowStepTemplate {
  const trainingData = { type: 'blobs', items: run.items };
  const optimizerType = run.optimizer.toLowerCase();

  const step = isFlux2(run.engine)
    ? {
        $type: 'imageResourceTraining',
        priority: 'normal',
        input: {
          engine: run.engine,
          // A pasted custom base overrides the version's default checkpoint AIR.
          model: run.customModel ?? run.model,
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
          // A pasted custom model is the base checkpoint to train on (the ecosystem otherwise resolves it).
          ...(run.customModel ? { model: run.customModel } : {}),
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
          // "Keep training": continue from a previous checkpoint's weights instead of the base model.
          ...(run.continueFrom ? { continueFrom: run.continueFrom } : {}),
          ...(traceMode !== 'none' ? { trace: traceMode } : {}),
          trainingData,
          samples: { prompts: run.prompts },
        },
      };

  return step as unknown as WorkflowStepTemplate;
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

/** Submit one real training workflow; returns its id. Charges Buzz — the single write in the flow. A
 *  `callbacks` entry registers the orchestrator push that emits live `workflow-update` signals for this run. */
export async function submitTraining(
  client: OrchestratorClient,
  run: TrainingRunInput,
  { callbacks, traceMode = 'events' }: SubmitOptions = {}
): Promise<string> {
  const metadata: TrainingStudioMeta = { ...run.meta, v: META_VERSION };
  const slug = run.meta.name ? nameSlug(run.meta.name) : '';
  const { data, error } = await submitWorkflow({
    client,
    body: {
      tags: slug
        ? [CIVITAI_TAG, TRAINING_TAG, `${NAME_TAG_PREFIX}${slug}`]
        : [CIVITAI_TAG, TRAINING_TAG],
      metadata: metadata as Record<string, unknown>,
      steps: [buildStep(run, traceMode)],
      currencies: resolveCurrencies(run.currencies),
      ...(callbacks ? { callbacks } : {}),
    },
    query: { wait: 0 },
  });
  if (!data?.id) throw new Error(`training submit failed: ${describeSubmitError(error)}`);
  return data.id;
}

/** A batch refused before anything was submitted — callers map it to their 400/"bad request" arm. */
export class TrainingBatchValidationError extends Error {}

/** Submit a batch of runs, one workflow each, in series, stopping at the first failure. If nothing
 *  landed the failure is rethrown (the whole batch is safe to retry); if some runs already landed
 *  their ids are returned instead, so the already-charged runs are never re-submitted. */
export async function submitTrainingBatch(
  client: OrchestratorClient,
  runs: TrainingRunInput[] | undefined,
  opts: SubmitOptions & { onRunError?: (err: unknown) => void } = {}
): Promise<string[]> {
  if (!runs?.length || runs.some((r) => !r?.items?.length || !r.ecosystem))
    throw new TrainingBatchValidationError('Bad training request.');

  const workflowIds: string[] = [];
  try {
    for (const run of runs) workflowIds.push(await submitTraining(client, run, opts));
  } catch (err) {
    opts.onRunError?.(err);
    if (workflowIds.length === 0) throw err;
  }
  return workflowIds;
}

type EpochOutput = {
  epochNumber?: number;
  model?: { id?: string; url?: string | null; available?: boolean };
};

// `continueFrom` must reference the epoch's trained LoRA, and the orchestrator resolves it as a LoRA only
// when the AIR carries the `lora` type and the run's real ecosystem — `other:other` is rejected with
// "continueFrom must reference a LoRA resource". Built with @civitai/client's `Air` (the same builder the
// main app's stringifyAIR wraps) for a blob-backed epoch: urn:air:<ecosystem>:lora:orchestrator:blob@<blobKey>.
const loraBlobAir = (ecosystem: string, blobKey: string) =>
  Air.stringify({ ecosystem, type: 'lora', source: 'orchestrator', id: 'blob', version: blobKey });

export interface ContinueOpts {
  workflowId: string;
  fromEpoch: number;
  /** Clamped to 1–20 at build time — callers pass the raw value. */
  addEpochs: number;
  currencies?: string[];
}

/** Reconstruct the submit body for a "keep training" continuation from the source run's own training step
 *  (ai-toolkit only), plus `continueFrom` and the added epochs. Shared by the real submit and the whatif so
 *  the quoted price matches what gets charged. `steps` is the continuation's step budget (for ETA). */
async function buildContinuation(
  client: OrchestratorClient,
  opts: ContinueOpts,
  { callbacks, traceMode = 'events' }: SubmitOptions
): Promise<{ body: WorkflowTemplate; steps: number | undefined }> {
  const addEpochs = Math.min(20, Math.max(1, Math.round(opts.addEpochs)));
  const { data: wf, error: getError } = await getWorkflow({
    client,
    path: { workflowId: opts.workflowId },
  });
  if (!wf)
    throw new Error(`keep training: source run not found (${describeSubmitError(getError)})`);

  const step =
    wf.steps?.find((s) => (s as { $type?: string }).$type === 'training') ?? wf.steps?.[0];
  const input = (step as { input?: Record<string, unknown> } | undefined)?.input;
  const output = (step as { output?: { epochs?: EpochOutput[] } } | undefined)?.output;
  if (!input || input.engine !== 'ai-toolkit')
    throw new Error('keep training: only ai-toolkit runs can continue from a checkpoint');

  const epoch = (output?.epochs ?? []).find(
    (e) => e.epochNumber === opts.fromEpoch && e.model?.available && typeof e.model.id === 'string'
  );
  const modelKey = epoch?.model?.id;
  if (!modelKey) throw new Error('keep training: that checkpoint has no downloadable weights yet');
  const ecosystem = typeof input.ecosystem === 'string' ? input.ecosystem : '';
  if (!ecosystem)
    throw new Error('keep training: source run has no ecosystem to reference the checkpoint by');
  const continueFrom = loraBlobAir(ecosystem, modelKey);

  const origEpochs = Number(input.epochs) || 10;
  const origSteps = Number(input.steps) || 0;
  // Keep the per-epoch step density of the source run for the added epochs.
  const steps = origSteps
    ? Math.max(1, Math.round((origSteps / origEpochs) * addEpochs))
    : undefined;

  const srcMeta = (wf.metadata ?? {}) as TrainingStudioMeta;
  const name = srcMeta.name ? `${srcMeta.name} (further)` : undefined;
  const metadata: TrainingStudioMeta = { ...srcMeta, name: name ?? srcMeta.name, v: META_VERSION };
  const slug = name ? nameSlug(name) : '';

  // Only the fields we submit (mirrors buildStep) — never the server-computed read-only ones the orch echoes
  // back (defaultSteps, storageBuzzPerEpoch, …), which it rejects on re-submit.
  const continuedInput = {
    engine: 'ai-toolkit',
    ecosystem: input.ecosystem,
    ...(input.modelVariant ? { modelVariant: input.modelVariant } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(steps ? { steps } : {}),
    epochs: addEpochs,
    batchSize: input.batchSize,
    lr: input.lr,
    textEncoderLr: input.textEncoderLr,
    trainTextEncoder: input.trainTextEncoder,
    lrScheduler: input.lrScheduler,
    optimizerType: input.optimizerType,
    networkDim: input.networkDim,
    networkAlpha: input.networkAlpha,
    resolution: input.resolution,
    triggerWord: input.triggerWord,
    continueFrom,
    ...(traceMode !== 'none' ? { trace: traceMode } : {}),
    trainingData: input.trainingData,
    samples: input.samples,
  };
  const continuedStep = {
    $type: 'training',
    priority: 'normal',
    input: continuedInput,
  } as unknown as WorkflowStepTemplate;

  return {
    body: {
      tags: slug
        ? [CIVITAI_TAG, TRAINING_TAG, `${NAME_TAG_PREFIX}${slug}`]
        : [CIVITAI_TAG, TRAINING_TAG],
      metadata: metadata as Record<string, unknown>,
      steps: [continuedStep],
      currencies: resolveCurrencies(opts.currencies),
      ...(callbacks ? { callbacks } : {}),
    },
    steps,
  };
}

/** "Keep training": submit a new run continuing from a checkpoint. Charges Buzz. Returns the new run id. */
export async function continueTraining(
  client: OrchestratorClient,
  opts: ContinueOpts,
  submitOpts: SubmitOptions = {}
): Promise<string> {
  const { body } = await buildContinuation(client, opts, submitOpts);
  const { data, error } = await submitWorkflow({ client, body, query: { wait: 0 } });
  if (!data?.id) throw new Error(`keep training: submit failed (${describeSubmitError(error)})`);
  return data.id;
}

/** Price a "keep training" continuation without submitting (the same body, `whatif`). Returns the total Buzz
 *  cost and the step budget (for an ETA), so the UI can show the price + confirm before charging. */
export async function continueTrainingWhatIf(
  client: OrchestratorClient,
  opts: ContinueOpts,
  submitOpts: SubmitOptions = {}
): Promise<{ cost: number | null; steps: number | undefined }> {
  const { body, steps } = await buildContinuation(client, opts, submitOpts);
  const { data, error } = await submitWorkflow({ client, body, query: { whatif: true } });
  if (!data) throw new Error(`keep training quote failed: ${describeSubmitError(error)}`);
  return { cost: data.cost?.total ?? null, steps };
}

/** Rename a training: merge the new name into the workflow metadata (the title the list/detail read) and
 *  swap its `name:<slug>` tag. Fetches current metadata/tags first so nothing else is dropped. Per-user —
 *  the token only resolves the caller's own workflows, so this can't rename someone else's. */
export async function renameTraining(
  client: OrchestratorClient,
  workflowId: string,
  name: string
): Promise<void> {
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
