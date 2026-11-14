import { buildKohyaInput } from './kohya-training';
import { kohyaFamily, type KohyaOptions, type KohyaInput } from './data/kohya';
import { formatYue2SamplePrompt } from '@civitai/shared/training-audio';
// Client-safe training submit builders: pure body construction + SDK calls against a provided
// client. Env-derived concerns are parameters — the shell's server wrappers (lib/server/train.ts)
// pass the trace mode from env and the per-user signal callbacks; the web-component backend passes
// its host config and no callbacks.
import {
  Air,
  deleteWorkflow,
  getResource,
  getWorkflow,
  headBlob,
  submitWorkflow,
  updateWorkflow,
  type BuzzClientAccount,
  type WorkflowCallback,
  type WorkflowStepTemplate,
  type WorkflowTemplate,
} from '@civitai/orchestration-client';
import {
  isSafeTensorFormat,
  NON_SAFETENSOR_CUSTOM_MODEL_MESSAGE,
} from '@civitai/shared/training-custom-model';
import {
  blobIdFromAir,
  describeSubmitError,
  forEachPooled,
  isTrainingDataNotReady,
  isFlux2,
  queryRecentWorkflows,
  resolveCurrencies,
  type OrchestratorClient,
} from './orchestrator-core';
import {
  isProdigy,
  MAX_NON_PRODIGY_LR,
  teTrainingUnsupportedReason,
  type ExtraParamField,
} from '$lib/data/trainingModels';
import {
  canDeleteRun,
  CIVITAI_TAG,
  epochModelKey,
  META_VERSION,
  TRAINING_TAG,
  type EpochModelOutput,
  type TrainingStudioMeta,
  workflowToRow,
} from '$lib/data/trainingRows';
import {
  EXTRA_PARAM_FIELDS,
  TARGET_STEPS,
  ecosystemAllowsCustomBase,
  ecosystemTakesSampleImages,
  ecosystemTrainsPairs,
  isRetiredBaseAir,
  isRetiredEcosystem,
} from '$lib/data/trainingModels';
import {
  blockedRunMessage,
  type RunModelRef,
  type TrainingServiceStatus,
} from '$lib/service-status-core';
import { FILES_PROCESSING_PARTIAL_REASON, FilesProcessingError } from '$lib/files-processing';
import { MatureAckRequiredError } from '$lib/mature-charge';
import { isMatureRating, type DatasetRating, type StoredRating } from '$lib/dataset-rating';
import { slugify } from '$lib/slug';
import type { TrainingTextCheck } from '$lib/training-text';

/** Captions remain raw until the engine-specific submit builder applies the trigger word. */
export interface TrainingItem {
  air: string;
  caption: string;
  /** Edit training only: where the blob sits in the dataset AI-Toolkit reads — `control_1/<name>` for a
   *  pair's starting image, `main/<name>` (same name, captioned with the instruction) for its result. */
  path?: string;
}

/** Everything the client assembles for one training run. Params arrive as the numbers the orchestrator
 *  wants (the Review step's string inputs are parsed client-side). */
export interface TrainingRunInput {
  ecosystem: string;
  modelVariant?: string;
  /** Ecosystem version selector (e.g. qwen's `version`). */
  version?: string;
  /** Defaults to AI Toolkit. Kohya uses `training`; Flux.2 uses `imageResourceTraining`. */
  engine?: string;
  kohya?: KohyaOptions;
  negativePrompt?: string;
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
  /** The extra ai-toolkit knobs. Optional on the wire — an older client (or the continuation
   *  rebuild of a run submitted before they shipped) omits them and the orchestrator applies its
   *  own defaults. `minSnrGamma` is only meaningful for SD-family ecosystems; senders leave it
   *  undefined elsewhere (`extraParamCapabilities`). */
  shuffleTokens?: boolean;
  keepTokens?: number;
  minSnrGamma?: number;
  noiseOffset?: number;
  flipAugmentation?: boolean;
  trigger: string;
  items: TrainingItem[];
  /** An edit LoRA: `items` are before/after pairs placed by `path`, sent with `isEditTraining`. Only
   *  for `ecosystemTrainsPairs`. */
  editTraining?: boolean;
  prompts: string[];
  /** Input images the samples are rendered from (edit LoRAs), index-aligned to `prompts`. Only for
   *  `ecosystemTakesSampleImages`; omit for text-only samples. */
  sourceImages?: string[];
  /** A previous checkpoint's blob-reference AIR to continue training from ("keep training"); omit for fresh. */
  continueFrom?: string;
  /** Which Buzz accounts to charge, in priority order (the user's choice on Review). Validated + defaulted
   *  by `resolveCurrencies` — never trusted from the wire. */
  currencies?: string[];
  /** The user ticked Review's mature-dataset confirm: the run unlocks mature content at submit and is
   *  charged in Yellow (after Blue when `currencies` spends Blue). */
  matureAck?: boolean;
  /**
   * One per run per Start attempt, minted by the flow (`newSubmitKey`) and REUSED when the user
   * starts the same batch again. It rides on the workflow as a tag, so a submit whose response was
   * lost can be found instead of charged a second time. Absent (an older client), nothing can be
   * reconciled and a submit is sent as before.
   */
  submitKey?: string;
  meta: TrainingStudioMeta;
}

/** Host-dependent submit knobs: the shell passes env trace mode + per-user signal callbacks; the
 *  element passes its host's trace mode and no callbacks. */
export interface SubmitOptions {
  callbacks?: WorkflowCallback[];
  /** Opt each epoch job into an NDJSON live trace (`events` or `logs`); `none` (the default) sends
   *  nothing — an unknown field on the submit could get the whole workflow rejected. */
  traceMode?: string;
  /** The training service status read just before the submit. A run on a blocked model is refused
   *  before any orchestrator call; omitted, only an `isBlockedCustomModel` base is refused. */
  status?: TrainingServiceStatus | null;
  /** Set when the v2 rating decides dataset maturity for this user: an image with a stored v2 rating is
   *  counted by it, every other image by its upload rating, as before. */
  datasetRating?: DatasetRating;
  /** Told how each dataset maturity count was made, for the run's log line. */
  onMatureCount?: (count: MatureCount) => void;
}

/** Why a run can't start right now — training is off, or its model is blocked — or null when it can. */
export function unavailableRunMessage(
  run: RunModelRef,
  status: TrainingServiceStatus | null | undefined
): string | null {
  if (status && !status.available) return status.message ?? 'Training is unavailable right now.';
  return blockedRunMessage(run, status);
}

// Real-spend wallets (Buzz), same set the whatif quotes against. The default when the client sends
// nothing valid.
const CURRENCIES: BuzzClientAccount[] = ['blue', 'yellow'];
const runCurrencies = (input?: string[]) => resolveCurrencies(input, CURRENCIES);

/** The accounts that may pay for mature content: Yellow, after Blue only if the user's order spends Blue
 *  (members may pay for mature content in Blue; the orchestrator drops it for everyone else). Never Green. */
function matureCurrencies(currencies: string[] | undefined): BuzzClientAccount[] {
  return runCurrencies(currencies).includes('blue') ? ['blue', 'yellow'] : ['yellow'];
}

/** How a submit is charged. Always `manual`, so viewing a run never changes what it was charged; a run the
 *  user confirmed as mature unlocks at submit instead, and is charged once, in the accounts that may pay
 *  for mature content. */
function chargeFields(currencies: string[] | undefined, matureUnlock: boolean) {
  return matureUnlock
    ? {
        upgradeMode: 'manual' as const,
        allowMatureContent: true,
        currencies: matureCurrencies(currencies),
      }
    : { upgradeMode: 'manual' as const, currencies: runCurrencies(currencies) };
}

/** The orchestrator's reason for a refused charge; the workflow is refunded in full before it answers. */
const INSUFFICIENT_BUZZ = 'insufficientBuzz';
const MATURE_SHORT_OF_YELLOW =
  'Not enough Yellow Buzz. Training on mature images is charged in Yellow; this run was not charged.';

function chargeFailureReason(reason: string, matureUnlock: boolean): string {
  return matureUnlock && reason === INSUFFICIENT_BUZZ ? MATURE_SHORT_OF_YELLOW : reason;
}

/** Identity of the blob an item's `air` names, for dedupe. Keys are case-insensitive base32. */
export function trainingBlobKey(air: string): string {
  return blobIdFromAir(air.trim()).toLowerCase();
}

/** The extra knobs `obj` actually carries — a submit or continuation sends only what was set, never
 *  an invented default. Iterates `EXTRA_PARAM_FIELDS` so a sixth knob can't be dropped here. */
function pick(obj: object, keys: readonly ExtraParamField[]): Record<string, unknown> {
  const source = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/** Build one run's training step. Both shapes carry the dataset as a blob list (the orchestrator accepts
 *  blobs for every engine; the SDK types imageResourceTraining's `trainingData` as a string, so that path
 *  is cast). The Flux.2 (imageResourceTraining) engine takes no hyperparameters — only the base model +
 *  data + prompts, matching the main app. Ai-toolkit's hyperparameters are sent as extra input fields the
 *  minimal SDK type doesn't declare — the same cast-past-the-type the whatif and the main app's builders use. */
function buildStep(run: TrainingRunInput, traceMode: string): WorkflowStepTemplate {
  // Backstop for the Data step's dedupe: the orchestrator rejects a dataset naming one blob twice. An
  // edit dataset places items by path instead, where one starting image may serve several pairs.
  const seen = new Set<string>();
  const items = run.items.filter((item) => {
    const key = item.path ?? trainingBlobKey(item.air);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const trainingData = { type: 'blobs' as const, items };
  if (run.engine === 'kohya')
    return {
      $type: 'training',
      priority: 'normal',
      input: buildKohyaInput(run, trainingData, traceMode),
    } as unknown as WorkflowStepTemplate;
  const optimizerType = run.optimizer.toLowerCase();
  // Prodigy finds its own step size and expects lr 1 (the main trainer forces it the same way);
  // forced here so a stale or saved run can't send a model's normal rate. A 0 TE rate stays 0 (TE off), and an ecosystem
  // that can't train the TE is forced to 0 before Prodigy is considered.
  const prodigy = isProdigy(run.optimizer);
  const lr = prodigy ? 1 : run.unetLr;
  const textEncoderLr = teTrainingUnsupportedReason(run.ecosystem)
    ? 0
    : prodigy && run.textEncoderLr > 0
    ? 1
    : run.textEncoderLr;

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
          trainingDataImagesCount: items.length,
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
          // Pin the picked version's checkpoint air (a pasted custom base wins). Without the pin,
          // shared-ecosystem cards silently trained on the ecosystem's DEFAULT base — Illustrious
          // and Pony both ran on plain SDXL 1.0. Price-neutral: whatif quotes identically with
          // and without it.
          ...(run.customModel || run.model ? { model: run.customModel || run.model } : {}),
          ...(run.modelVariant ? { modelVariant: run.modelVariant } : {}),
          ...(run.version ? { version: run.version } : {}),
          ...(run.editTraining ? { isEditTraining: true } : {}),
          steps: run.steps,
          epochs: run.epochs,
          batchSize: run.batchSize,
          lr,
          textEncoderLr,
          trainTextEncoder: textEncoderLr > 0,
          lrScheduler: run.lrScheduler,
          optimizerType,
          networkDim: run.networkDim,
          networkAlpha: run.networkAlpha,
          resolution: run.resolution,
          ...pick(run, EXTRA_PARAM_FIELDS),
          triggerWord: run.trigger,
          // "Keep training": continue from a previous checkpoint's weights instead of the base model.
          ...(run.continueFrom ? { continueFrom: run.continueFrom } : {}),
          ...(traceMode !== 'none' ? { trace: traceMode } : {}),
          trainingData,
          samples: {
            prompts:
              run.ecosystem === 'yue2' ? run.prompts.map(formatYue2SamplePrompt) : run.prompts,
            ...(run.sourceImages?.length ? { sourceImages: run.sourceImages } : {}),
          },
        },
      };

  return step as unknown as WorkflowStepTemplate;
}

// The workflow carries the run name both as `metadata.name` (the displayed title) and a `name:<slug>` tag
// (for finding it). This prefix is the one place the tag shape is written and matched.
const NAME_TAG_PREFIX = 'name:';

/** The tag a submit key rides on; hex only, so it needs no escaping anywhere. */
const SUBMIT_KEY_TAG_PREFIX = 'submit:';
const SUBMIT_KEY = /^[0-9a-f]{16,64}$/;
/** A submit that has not answered in this long is abandoned and reconciled by its key. */
export const SUBMIT_TIMEOUT_MS = 30_000;
const SUBMIT_LOOKUP_TIMEOUT_MS = 10_000;

/** The id of the training workflow already submitted under `key`, if any. Throws when it can't tell. */
async function findSubmittedRun(client: OrchestratorClient, key: string) {
  const items = await queryRecentWorkflows(
    client,
    [CIVITAI_TAG, TRAINING_TAG, `${SUBMIT_KEY_TAG_PREFIX}${key}`],
    { signal: AbortSignal.timeout(SUBMIT_LOOKUP_TIMEOUT_MS) }
  );
  return items.find((w) => w.id)?.id ?? undefined;
}

/** Submit one real training workflow; returns its id. Charges Buzz — the single write in the flow. A
 *  `callbacks` entry registers the orchestrator push that emits live `workflow-update` signals for this run. */
export async function submitTraining(
  client: OrchestratorClient,
  run: TrainingRunInput,
  { callbacks, traceMode = 'events' }: SubmitOptions = {}
): Promise<string> {
  const metadata: TrainingStudioMeta = { ...run.meta, v: META_VERSION };
  const slug = run.meta.name ? slugify(run.meta.name) : '';
  const key = run.submitKey && SUBMIT_KEY.test(run.submitKey) ? run.submitKey : undefined;

  // A second Start of the same batch (the user retrying after an error) returns the run the first
  // one created rather than charging again. If we cannot ask, we do not submit: fail closed.
  if (key) {
    let existing: string | undefined;
    try {
      existing = await findSubmittedRun(client, key);
    } catch {
      throw new TrainingSubmitError(
        'the training service did not respond, so nothing was started',
        undefined
      );
    }
    if (existing) return existing;
  }

  const tags = [CIVITAI_TAG, TRAINING_TAG];
  if (slug) tags.push(`${NAME_TAG_PREFIX}${slug}`);
  if (key) tags.push(`${SUBMIT_KEY_TAG_PREFIX}${key}`);

  let result: Awaited<ReturnType<typeof submitWorkflow>> | undefined;
  let thrown: unknown;
  try {
    result = await submitWorkflow({
      client,
      body: {
        tags,
        metadata: metadata as Record<string, unknown>,
        ...trainingSteps(run, traceMode, run.matureAck === true),
        ...(callbacks ? { callbacks } : {}),
      },
      query: { wait: 0 },
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (err) {
    thrown = err;
  }
  const data = result?.data as { id?: string | null } | undefined;
  // The SDK's success variant has no `error` field, so narrow before reading it.
  const error = result && 'error' in result ? result.error : undefined;
  const status = result?.response?.status;
  if (data?.id) return data.id;
  if (!thrown && isTrainingDataNotReady(error, status)) throw new FilesProcessingError();

  // No answer, a timeout, or a 5xx: the orchestrator may have created (and charged) the workflow
  // anyway. Look for it by key before reporting a failure the user would answer by retrying.
  const mayHaveLanded =
    thrown !== undefined || status === undefined || status >= 500 || status === 408;
  if (key && mayHaveLanded) {
    const landed = await findSubmittedRun(client, key).catch(() => undefined);
    if (landed) return landed;
  }
  if (thrown !== undefined) throw thrown;
  throw new TrainingSubmitError(
    chargeFailureReason(describeSubmitError(error), run.matureAck === true),
    status
  );
}

/** The step and charge fields of a training submit; the readiness whatif sends the same. */
function trainingSteps(run: TrainingRunInput, traceMode: string, matureUnlock: boolean) {
  return { steps: [buildStep(run, traceMode)], ...chargeFields(run.currencies, matureUnlock) };
}

const READINESS_WHATIF_TIMEOUT_MS = 30_000;

/** Whether the orchestrator would take this run's dataset now, from a whatif of the real submit body (never
 *  charges). False only when it answers that a file isn't ready; null for any other answer. */
export async function trainingDataReady(
  client: OrchestratorClient,
  run: TrainingRunInput
): Promise<boolean | null> {
  try {
    validateRun(run, 'run');
  } catch {
    return null;
  }
  const { data, error, response } = await submitWorkflow({
    client,
    body: trainingSteps(run, 'events', false),
    query: { whatif: true },
    signal: AbortSignal.timeout(READINESS_WHATIF_TIMEOUT_MS),
  });
  if (data) return true;
  return isTrainingDataNotReady(error, response?.status) ? false : null;
}

// Unauthorized (expired token), request timeout, rate limited.
const TRANSIENT_CLIENT_STATUSES = new Set([401, 408, 429]);

/** The orchestrator did not accept a submit. `status` is its HTTP status, absent when it never answered. */
export class TrainingSubmitError extends Error {
  readonly reason: string;
  readonly status: number | undefined;
  constructor(reason: string, status: number | undefined) {
    super(`training submit failed: ${reason}`);
    this.reason = reason;
    this.status = status;
  }

  /** A 4xx is a refusal of this payload that a retry would repeat — except these, which can clear on retry. */
  get isRefusal(): boolean {
    if (this.status === undefined || TRANSIENT_CLIENT_STATUSES.has(this.status)) return false;
    return this.status >= 400 && this.status < 500;
  }
}

/** A batch refused before anything was submitted — callers map it to their 400/"bad request" arm. */
export class TrainingBatchValidationError extends Error {}

export {
  TrainingTextCheckError,
  TrainingTextRefusedError,
  type TrainingTextCheck,
} from '$lib/training-text';

function fail(field: string, why: string): never {
  throw new TrainingBatchValidationError(`${field} ${why}`);
}

// The paste field's gate (trainingFlow.ts isValidAir) OR'd with Air's grammar — each accepts strings
// the other rejects, and the wire check must never refuse a value the UI accepted.
function isPlausibleAir(value: string): boolean {
  const trimmed = value.trim();
  return /^urn:air:[^\s]+$/.test(trimmed) || Air.isAir(trimmed);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyString = (v: unknown): v is string => isString(v) && v.trim().length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// textEncoderLr is the one hyperparameter where 0 is meaningful (it turns trainTextEncoder off).
const POSITIVE_NUMBER_FIELDS = [
  'steps',
  'epochs',
  'batchSize',
  'unetLr',
  'networkDim',
  'networkAlpha',
  'resolution',
] as const;
const OPTIONAL_NON_NEGATIVE_FIELDS = ['keepTokens', 'minSnrGamma', 'noiseOffset'] as const;
const OPTIONAL_BOOLEAN_FIELDS = ['shuffleTokens', 'flipAugmentation'] as const;
const OPTIONAL_STRING_FIELDS = [
  'modelVariant',
  'version',
  'engine',
  'model',
  'negativePrompt',
] as const;
const AIR_FIELDS = ['customModel', 'continueFrom'] as const;

/** Refuse a malformed run before it costs an orchestrator round-trip. The wire types are a cast, so
 *  every field is treated as unknown; failures name the offending field. */
function validateRun(run: TrainingRunInput | undefined, field: string): void {
  if (!run || typeof run !== 'object') fail(field, 'must be an object.');
  if (!isNonEmptyString(run.ecosystem)) fail(`${field}.ecosystem`, 'must be a non-empty string.');
  for (const key of POSITIVE_NUMBER_FIELDS) {
    if (!isFiniteNumber(run[key]) || run[key] <= 0)
      fail(`${field}.${key}`, 'must be a positive number.');
  }
  if (run.steps > TARGET_STEPS.max)
    fail(`${field}.steps`, `must be at most ${TARGET_STEPS.max.toLocaleString()}.`);
  if (!isFiniteNumber(run.textEncoderLr) || run.textEncoderLr < 0)
    fail(`${field}.textEncoderLr`, 'must be a non-negative number.');
  if (!isNonEmptyString(run.lrScheduler))
    fail(`${field}.lrScheduler`, 'must be a non-empty string.');
  if (!isNonEmptyString(run.optimizer)) fail(`${field}.optimizer`, 'must be a non-empty string.');
  if (run.engine !== 'kohya' && !isProdigy(run.optimizer)) {
    // A locked TE rate is sent as 0 whatever it holds, so a stale one is no reason to refuse.
    const lrKeys = teTrainingUnsupportedReason(run.ecosystem)
      ? (['unetLr'] as const)
      : (['unetLr', 'textEncoderLr'] as const);
    for (const key of lrKeys) {
      if (run[key] >= MAX_NON_PRODIGY_LR)
        fail(
          `${field}.${key}`,
          `must be less than ${MAX_NON_PRODIGY_LR} for non-Prodigy optimizers.`
        );
    }
  }
  for (const key of OPTIONAL_NON_NEGATIVE_FIELDS) {
    if (run[key] !== undefined && !(isFiniteNumber(run[key]) && run[key] >= 0))
      fail(`${field}.${key}`, 'must be a non-negative number.');
  }
  if (run.keepTokens !== undefined && !Number.isInteger(run.keepTokens))
    fail(`${field}.keepTokens`, 'must be an integer.');
  for (const key of OPTIONAL_BOOLEAN_FIELDS) {
    if (run[key] !== undefined && typeof run[key] !== 'boolean')
      fail(`${field}.${key}`, 'must be a boolean.');
  }
  if (!isString(run.trigger)) fail(`${field}.trigger`, 'must be a string.');
  if (!Array.isArray(run.items) || run.items.length === 0)
    fail(`${field}.items`, 'must be a non-empty array.');
  if (run.editTraining !== undefined && typeof run.editTraining !== 'boolean')
    fail(`${field}.editTraining`, 'must be a boolean.');
  if (run.editTraining) validatePairs(run, field);
  else if (run.items.some((item) => typeof item === 'object' && item !== null && 'path' in item))
    fail(`${field}.items`, 'carry a path only for edit training.');
  run.items.forEach((item, i) => {
    if (!item || typeof item !== 'object') fail(`${field}.items[${i}]`, 'must be an object.');
    if (!isNonEmptyString(item.air))
      fail(`${field}.items[${i}].air`, 'must be a non-empty string.');
    if (!isString(item.caption)) fail(`${field}.items[${i}].caption`, 'must be a string.');
  });
  if (!Array.isArray(run.prompts) || run.prompts.some((p) => !isString(p)))
    fail(`${field}.prompts`, 'must be an array of strings.');
  if (run.sourceImages !== undefined) {
    if (!Array.isArray(run.sourceImages) || !run.sourceImages.every(isNonEmptyString))
      fail(`${field}.sourceImages`, 'must be an array of image URLs.');
    if (isFlux2(run.engine) || !ecosystemTakesSampleImages(run.ecosystem))
      fail(`${field}.sourceImages`, 'are not supported for this model.');
    // The orchestrator pairs them by index; a short list would render some samples from nothing.
    if (run.sourceImages.length !== run.prompts.length)
      fail(`${field}.sourceImages`, 'must have one image per sample prompt.');
  }
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (run[key] !== undefined && !isString(run[key])) fail(`${field}.${key}`, 'must be a string.');
  }
  for (const key of AIR_FIELDS) {
    const value = run[key];
    if (value !== undefined && !(isNonEmptyString(value) && isPlausibleAir(value)))
      fail(`${field}.${key}`, 'must be an AIR (urn:air:…).');
  }
  if (
    run.currencies !== undefined &&
    (!Array.isArray(run.currencies) || run.currencies.some((c) => !isString(c)))
  )
    fail(`${field}.currencies`, 'must be an array of strings.');
  if (run.matureAck !== undefined && typeof run.matureAck !== 'boolean')
    fail(`${field}.matureAck`, 'must be a boolean.');
  if (!run.meta || typeof run.meta !== 'object') fail(`${field}.meta`, 'must be an object.');
  if (run.meta.name !== undefined && !isString(run.meta.name))
    fail(`${field}.meta.name`, 'must be a string.');
  // A sweep row or restored selection can still carry one; submitting it would bill a run that
  // trains on the official base.
  if (
    run.customModel !== undefined &&
    !ecosystemAllowsCustomBase(run.ecosystem) &&
    !(run.engine === 'kohya' && kohyaFamily(run.ecosystem))
  )
    fail(`${field}.customModel`, 'is not supported for this model.');
  // A restored selection or sweep row can still name a retired card's base.
  if (isNonEmptyString(run.model) && isRetiredBaseAir(run.model))
    fail(`${field}.model`, 'is no longer offered for training.');
  if (isRetiredEcosystem(run.ecosystem))
    fail(`${field}.ecosystem`, 'is no longer offered for training.');
  if (run.engine && run.engine !== 'ai-toolkit' && run.engine !== 'kohya' && !isFlux2(run.engine))
    fail(`${field}.engine`, 'is not supported.');
  if (run.engine === 'kohya') {
    try {
      buildKohyaInput(run, { type: 'blobs', items: run.items }, 'none');
    } catch (error) {
      fail(field, error instanceof Error ? error.message : 'Invalid Kohya settings.');
    }
  }
  if (isFlux2(run.engine) && !isNonEmptyString(run.customModel ?? run.model))
    fail(`${field}.model`, 'is required for this engine.');
}

// `control_1/pair_0001.png`, `main/pair_0001.jpg`: a folder AI-Toolkit reads, then a plain file name.
const PAIR_PATH = /^(control_1|main)\/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/;

/** An edit dataset is pairs: every `main/` result has a `control_1/` starting image of the same name and
 *  an instruction, and every starting image has its result — an unmatched half would train as nothing. */
function validatePairs(run: TrainingRunInput, field: string): void {
  if (isFlux2(run.engine) || !ecosystemTrainsPairs(run.ecosystem))
    fail(`${field}.editTraining`, 'is not supported for this model.');
  const sides = { control_1: new Set<string>(), main: new Set<string>() };
  run.items.forEach((item, i) => {
    const match = typeof item?.path === 'string' ? PAIR_PATH.exec(item.path) : null;
    if (!match) fail(`${field}.items[${i}].path`, 'must be control_1/<name> or main/<name>.');
    const side = sides[match[1] as keyof typeof sides];
    if (side.has(match[2]!)) fail(`${field}.items[${i}].path`, 'names a pair twice.');
    side.add(match[2]!);
    if (match[1] === 'main' && !(typeof item.caption === 'string' && item.caption.trim()))
      fail(`${field}.items[${i}].caption`, 'must hold the instruction.');
  });
  const unmatched =
    [...sides.main].find((n) => !sides.control_1.has(n)) ??
    [...sides.control_1].find((n) => !sides.main.has(n));
  if (unmatched !== undefined) fail(`${field}.items`, `pair ${unmatched} is missing an image.`);
}

/** Refuse a custom base model whose weights aren't SafeTensor — the rule the main app's
 *  checkCustomModel enforces (single home: @civitai/shared/training-custom-model), read here off
 *  the orchestrator's resolved format instead of a ModelFile row. A 404 refuses too (the AIR names
 *  nothing trainable); any other lookup failure is no validation verdict, so it propagates as the
 *  callers' retryable arm. */
async function assertCustomModelTrainable(
  client: OrchestratorClient,
  air: string,
  field: string
): Promise<void> {
  const { data, response } = await getResource({ client, path: { air } });
  if (!data) {
    if (response?.status === 404)
      throw new TrainingBatchValidationError(`${field}.customModel: model could not be found.`);
    throw new Error(`custom model lookup failed (${response?.status ?? 'no response'})`);
  }
  if (!isSafeTensorFormat(data.fileFormat))
    throw new TrainingBatchValidationError(
      `${field}.customModel: ${NON_SAFETENSOR_CUSTOM_MODEL_MESSAGE}`
    );
}

/** Refuse, before anything is charged, a run whose dataset is mature but carries no confirm: the client's
 *  own mature count is not trusted. Under the v2 rating a confirm is dropped (no Yellow) when a clean count
 *  finds nothing mature, since Review may have sent it before its own count answered. Every run of a sweep
 *  shares its dataset, so it is rated once. Returns the runs as they will be charged. */
async function assertMatureAcked(
  client: OrchestratorClient,
  runs: TrainingRunInput[],
  opts: Pick<SubmitOptions, 'datasetRating' | 'onMatureCount'> = {}
): Promise<TrainingRunInput[]> {
  const counts = new Map<string, Promise<MatureCount>>();
  const resolved: TrainingRunInput[] = [];
  for (const run of runs) {
    const acked = run.matureAck === true;
    if (acked && !opts.datasetRating) {
      resolved.push(run);
      continue;
    }
    const airs = [...new Set(run.items.map((item) => item.air))].sort();
    const key = airs.join('\n');
    if (!counts.has(key))
      counts.set(
        key,
        countMatureBlobs(client, airs, opts.datasetRating).then((r) => {
          opts.onMatureCount?.(r);
          return r;
        })
      );
    const { mature, failed } = await counts.get(key)!;
    if (!acked && mature > 0) throw new MatureAckRequiredError(mature);
    resolved.push(acked && mature === 0 && failed === 0 ? { ...run, matureAck: false } : run);
  }
  return resolved;
}

export interface SubmittedBatch {
  workflowIds: string[];
  /** Why the runs after `workflowIds` were not confirmed (they may still have started); set only when
   *  some runs landed and a later one failed. */
  failure?: string;
}

/** A submit failure as the user should read it: the orchestrator's own reason when it gave one. */
export function submitFailureReason(err: unknown): string {
  if (err instanceof FilesProcessingError) return FILES_PROCESSING_PARTIAL_REASON;
  return err instanceof TrainingSubmitError ? err.reason : 'the training service did not respond';
}

/** Submit a batch of runs, one workflow each, in series, stopping at the first failure. If nothing
 *  landed the failure is rethrown (the whole batch is safe to retry); if some runs already landed
 *  their ids are returned with the failure's reason, so the already-charged runs are never re-submitted. */
export async function submitTrainingBatch(
  client: OrchestratorClient,
  runs: TrainingRunInput[] | undefined,
  opts: SubmitOptions & {
    checkText: TrainingTextCheck;
    onRunError?: (err: unknown, runIndex: number) => void;
  }
): Promise<SubmittedBatch> {
  if (!Array.isArray(runs) || runs.length === 0)
    throw new TrainingBatchValidationError('runs must be a non-empty array.');
  runs.forEach((run, i) => validateRun(run, `runs[${i}]`));
  for (const run of runs) {
    const unavailable = unavailableRunMessage(run, opts.status);
    if (unavailable) throw new TrainingBatchValidationError(unavailable);
  }
  const charged = await assertMatureAcked(client, runs, opts);

  // Every run's trigger word is checked before ANY submit, so a refused batch never part-charges. A
  // sweep repeats one trigger word across runs; each distinct one is checked once.
  for (const triggerWord of new Set(runs.map((run) => run.trigger)))
    await opts.checkText({ triggerWord });

  // All custom-model checks happen before ANY submit, so a refused batch never part-charges.
  const customModels = new Map<string, string>();
  runs.forEach((run, i) => {
    if (run.customModel && !customModels.has(run.customModel))
      customModels.set(run.customModel, `runs[${i}]`);
  });
  for (const [air, field] of customModels) await assertCustomModelTrainable(client, air, field);

  const workflowIds: string[] = [];
  try {
    for (const run of charged) workflowIds.push(await submitTraining(client, run, opts));
  } catch (err) {
    opts.onRunError?.(err, workflowIds.length);
    if (workflowIds.length === 0) throw err;
    return { workflowIds, failure: submitFailureReason(err) };
  }
  return { workflowIds };
}

type EpochOutput = {
  epochNumber?: number;
  model?: EpochModelOutput;
};

// An epoch's trained-LoRA reference (`continueFrom`, the generate hand-off): the orchestrator resolves it
// as a LoRA only when the AIR carries the `lora` type and the run's real ecosystem — `other:other` is
// rejected with "continueFrom must reference a LoRA resource". Built with @civitai/orchestration-client's `Air` (the same
// builder the main app's stringifyAIR wraps) for a blob-backed epoch:
// urn:air:<ecosystem>:lora:orchestrator:blob@<blobKey>.
export const loraBlobAir = (ecosystem: string, blobKey: string) =>
  Air.stringify({ ecosystem, type: 'lora', source: 'orchestrator', id: 'blob', version: blobKey });

// The orchestrator requires `continueFrom`'s AIR ecosystem to equal its own name for the training model's
// ecosystem, which differs from the step's `ecosystem` input for these — sending the input name fails with
// "continueFrom ecosystem 'mossImage' must match the training model ecosystem 'moss'". Every other
// ai-toolkit ecosystem in the catalog passes as-is (checked against the orchestrator's whatif, 2026-10-21).
const CONTINUE_FROM_ECOSYSTEM: Record<string, string> = {
  flux2klein: 'flux2',
  flux3klein: 'flux3',
  mossImage: 'moss',
  wan: 'wanvideo',
};

const continueFromAir = (ecosystem: string, blobKey: string) =>
  loraBlobAir(CONTINUE_FROM_ECOSYSTEM[ecosystem] ?? ecosystem, blobKey);

export interface ContinueOpts {
  workflowId: string;
  fromEpoch: number;
  /** Clamped to 1–20 at build time — callers pass the raw value. */
  addEpochs: number;
  currencies?: string[];
  /** The user confirmed the mature-dataset Yellow charge on the continue panel. */
  matureAck?: boolean;
}

export { MatureAckRequiredError };

const MATURE_NSFW_LEVELS = new Set(['r', 'x', 'xxx']);
const PROBE_CONCURRENCY = 8;
const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_MAX = 200;
const probeCache = new Map<string, { at: number; count: Promise<number> }>();

export interface MatureCount {
  images: number;
  mature: number;
  /** HEADs that failed: those images count as not mature, and the count is never cached. */
  failed: number;
  /** Images counted by a stored v2 rating; the rest were counted from X-NSFW-Level. */
  rated: number;
  /** Blob ids the caller can read that have no stored v2 rating yet (always empty without a rating). */
  unratedKeys: string[];
}

/** How many of a dataset's blobs are mature. Each blob's X-NSFW-Level header counts R and above;
 *  with `rating`, a blob the caller can read that has a stored v2 rating is counted by that instead.
 *  Never send a workflowId on these HEADs. */
async function countMatureBlobs(
  client: OrchestratorClient,
  airs: string[],
  rating?: DatasetRating
): Promise<MatureCount> {
  const stored: Map<string, StoredRating> = rating
    ? await rating.read(airs.map(trainingBlobKey)).catch(() => new Map())
    : new Map();
  let mature = 0;
  let failed = 0;
  let rated = 0;
  const unratedKeys: string[] = [];
  await forEachPooled(airs, PROBE_CONCURRENCY, async (air) => {
    try {
      const { response } = await headBlob({ client, path: { blobId: blobIdFromAir(air) } });
      if (!response?.ok) failed++;
      // Only for a blob this caller's HEAD could read: the cache is shared across users.
      const v2 = rating && response?.ok ? stored.get(trainingBlobKey(air)) : undefined;
      if (v2) {
        rated++;
        if (isMatureRating(v2, rating!.matureLevel)) mature++;
        return;
      }
      if (rating && response?.ok) unratedKeys.push(blobIdFromAir(air));
      const level = response?.headers.get('x-nsfw-level')?.toLowerCase();
      if (level && MATURE_NSFW_LEVELS.has(level)) mature++;
    } catch {
      failed++;
    }
  });
  return { images: airs.length, mature, failed, rated, unratedKeys };
}

/** A dataset's mature count for Review, the same count the submit makes. */
export function countDatasetMature(
  client: OrchestratorClient,
  airs: string[],
  rating?: DatasetRating
): Promise<MatureCount> {
  return countMatureBlobs(client, [...new Set(airs)].sort(), rating);
}

/** Called only after the caller's own token read the workflow, so a cached count never leaks across
 *  users. Blobs are immutable, so the quote and the submit share one probe; a probe with a failed HEAD,
 *  or (under the v2 rating) with images not yet rated, isn't kept, so the next quote or the submit counts
 *  the dataset again. Counts with and without the v2 rating, and at each setting, are kept apart. */
function sourceMatureCount(
  client: OrchestratorClient,
  workflowId: string,
  airs: string[],
  rating?: DatasetRating,
  onMatureCount?: (count: MatureCount) => void
): Promise<number> {
  const now = Date.now();
  const key = rating ? `${workflowId}\nv2:${rating.matureLevel}` : workflowId;
  const hit = probeCache.get(key);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.count;
  if (probeCache.size >= PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value!);
  const count = countMatureBlobs(client, airs, rating).then((counted) => {
    onMatureCount?.(counted);
    const { mature, failed, unratedKeys } = counted;
    if ((failed > 0 || unratedKeys.length > 0) && probeCache.get(key)?.count === count)
      probeCache.delete(key);
    return mature;
  });
  probeCache.set(key, { at: now, count });
  return count;
}

/** Quote and submit share continuation training parameters; mature-content charging fields can differ. */
async function buildContinuation(
  client: OrchestratorClient,
  opts: ContinueOpts,
  { callbacks, traceMode = 'events', status, datasetRating, onMatureCount }: SubmitOptions
): Promise<{
  body: WorkflowTemplate;
  steps: number | undefined;
  triggerWord: string;
  matureCount: number;
}> {
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
  if (!input || (input.engine !== 'ai-toolkit' && input.engine !== 'kohya'))
    throw new Error('keep training: this engine cannot continue from a checkpoint');

  const epoch = (output?.epochs ?? []).find(
    (e) => e.epochNumber === opts.fromEpoch && epochModelKey(e.model) !== undefined
  );
  const modelKey = epochModelKey(epoch?.model);
  if (!modelKey) throw new Error('keep training: that checkpoint has no downloadable weights yet');
  const ecosystem =
    input.engine === 'kohya' && typeof input.model === 'string'
      ? Air.parseSafe(input.model)?.ecosystem ?? ''
      : typeof input.ecosystem === 'string'
      ? input.ecosystem
      : '';
  if (!ecosystem)
    throw new Error('keep training: source run has no ecosystem to reference the checkpoint by');
  // A retired card can share a live ecosystem (Hunyuan trains as `wan`), so check the base too.
  if (
    isRetiredEcosystem(ecosystem) ||
    (typeof input.model === 'string' && isRetiredBaseAir(input.model))
  )
    throw new Error('keep training: this model is no longer offered for training');
  // The source's `model` is what it trained (`customModel || model` at submit).
  const unavailable = unavailableRunMessage(
    {
      ecosystem,
      modelVariant: typeof input.modelVariant === 'string' ? input.modelVariant : undefined,
      version: typeof input.version === 'string' ? input.version : undefined,
      model: typeof input.model === 'string' ? input.model : undefined,
    },
    status
  );
  if (unavailable) throw new TrainingBatchValidationError(unavailable);
  const continueFrom = continueFromAir(ecosystem, modelKey);

  const origEpochs = Number(input.engine === 'kohya' ? input.maxTrainEpochs : input.epochs) || 10;
  const origSteps = Number(input.steps) || 0;
  // Keep the per-epoch step density of the source run for the added epochs.
  const steps = origSteps
    ? Math.max(1, Math.round((origSteps / origEpochs) * addEpochs))
    : undefined;

  const srcMeta = (wf.metadata ?? {}) as TrainingStudioMeta;
  const airs = ((input.trainingData as { items?: { air?: unknown }[] } | undefined)?.items ?? [])
    .map((i) => i.air)
    .filter((a): a is string => typeof a === 'string' && a.length > 0);
  // A stamped positive count is trusted (it can only ask the user to confirm); 0 or none is re-checked.
  const matureCount =
    typeof srcMeta.matureCount === 'number' && srcMeta.matureCount > 0
      ? srcMeta.matureCount
      : await sourceMatureCount(client, opts.workflowId, airs, datasetRating, onMatureCount);
  const matureUnlock = matureCount > 0 && opts.matureAck === true;
  const name = srcMeta.name ? `${srcMeta.name} (further)` : undefined;
  // Lineage always points at the IMMEDIATE parent — a copied-through sourceWorkflowId from the
  // source's own metadata would skip a link in the chain.
  const metadata: TrainingStudioMeta = {
    ...srcMeta,
    name: name ?? srcMeta.name,
    v: META_VERSION,
    sourceWorkflowId: opts.workflowId,
    sourceEpoch: opts.fromEpoch,
    matureCount,
  };
  const slug = name ? slugify(name) : '';

  // Only the fields we submit (mirrors buildStep) — never the server-computed read-only ones the orch echoes
  // back (defaultSteps, storageBuzzPerEpoch, …), which it rejects on re-submit.
  const continuedInput =
    input.engine === 'kohya'
      ? continueKohyaInput(input, addEpochs, steps, continueFrom, traceMode)
      : {
          engine: 'ai-toolkit',
          ecosystem: input.ecosystem,
          // The source's base pin (see buildStep): without it an Illustrious/Pony/custom-SDXL run continues
          // on the ecosystem's default base and publishes as that base.
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelVariant ? { modelVariant: input.modelVariant } : {}),
          ...(input.version ? { version: input.version } : {}),
          // Without it the pair dataset would continue as a plain LoRA dataset.
          ...(input.isEditTraining === true ? { isEditTraining: true } : {}),
          ...(steps ? { steps } : {}),
          epochs: addEpochs,
          batchSize: input.batchSize,
          lr: input.lr,
          // Runs submitted before the lock still carry TE on; don't continue them with it.
          ...(teTrainingUnsupportedReason(ecosystem)
            ? { textEncoderLr: 0, trainTextEncoder: false }
            : { textEncoderLr: input.textEncoderLr, trainTextEncoder: input.trainTextEncoder }),
          lrScheduler: input.lrScheduler,
          optimizerType: input.optimizerType,
          networkDim: input.networkDim,
          networkAlpha: input.networkAlpha,
          resolution: input.resolution,
          ...pick(input, EXTRA_PARAM_FIELDS),
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
      ...chargeFields(opts.currencies, matureUnlock),
      ...(callbacks ? { callbacks } : {}),
    },
    steps,
    triggerWord: String(input.engine === 'kohya' ? srcMeta.trigger ?? '' : input.triggerWord ?? ''),
    matureCount,
  };
}

const KOHYA_CONTINUE_KEYS = [
  'model',
  'numRepeats',
  'trainBatchSize',
  'resolution',
  'enableBucket',
  'shuffleCaption',
  'keepTokens',
  'clipSkip',
  'flipAugmentation',
  'unetLR',
  'textEncoderLR',
  'trainTextEncoder',
  'lrScheduler',
  'lrSchedulerNumCycles',
  'minSnrGamma',
  'networkDim',
  'networkAlpha',
  'noiseOffset',
  'optimizerType',
  'seed',
  'fp8Base',
  'blocksToSwap',
  'vParameterization',
  'zeroTerminalSnr',
  'trainingData',
  'samples',
  'clipLModel',
  'textEncoderModel',
  'vaeModel',
] as const satisfies readonly (keyof KohyaInput)[];

function continueKohyaInput(
  input: Record<string, unknown>,
  epochs: number,
  steps: number | undefined,
  continueFrom: string,
  trace: string
) {
  if (epochs > 20 || (steps !== undefined && steps > TARGET_STEPS.max))
    throw new Error(
      'keep training: Kohya supports at most 20 checkpoints and 10,000 steps per run.'
    );
  return {
    ...Object.fromEntries(
      KOHYA_CONTINUE_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])
    ),
    engine: 'kohya',
    maxTrainEpochs: epochs,
    ...(steps ? { steps } : {}),
    continueFrom,
    trace,
  };
}

/** "Keep training": submit a new run continuing from a checkpoint. Charges Buzz. Returns the new run id. */
export async function continueTraining(
  client: OrchestratorClient,
  opts: ContinueOpts,
  submitOpts: SubmitOptions & { checkText: TrainingTextCheck }
): Promise<string> {
  const { body, triggerWord, matureCount } = await buildContinuation(client, opts, submitOpts);
  if (matureCount > 0 && opts.matureAck !== true) throw new MatureAckRequiredError(matureCount);
  // The source run may predate the check, so its trigger word is checked again before it trains again.
  await submitOpts.checkText({ triggerWord });
  const { data, error, response } = await submitWorkflow({ client, body, query: { wait: 0 } });
  if (!data?.id) {
    const reason = describeSubmitError(error, response?.status);
    if (body.allowMatureContent === true && reason === INSUFFICIENT_BUZZ)
      throw new Error(MATURE_SHORT_OF_YELLOW);
    throw new Error(`keep training: submit failed (${reason})`);
  }
  return data.id;
}

/** Price a "keep training" continuation without submitting (the same body, `whatif`). Returns the total Buzz
 *  cost and the step budget (for an ETA), so the UI can show the price + confirm before charging. */
export async function continueTrainingWhatIf(
  client: OrchestratorClient,
  opts: ContinueOpts,
  submitOpts: SubmitOptions = {}
): Promise<{ cost: number | null; steps: number | undefined; matureCount: number }> {
  // Priced without the unlock: the total is the same, and a whatif needs no Yellow on hand.
  const { body, steps, matureCount } = await buildContinuation(
    client,
    { ...opts, matureAck: false },
    submitOpts
  );
  const { data, error, response } = await submitWorkflow({ client, body, query: { whatif: true } });
  if (!data)
    throw new Error(`keep training quote failed: ${describeSubmitError(error, response?.status)}`);
  return { cost: data.cost?.total ?? null, steps, matureCount };
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
  const slug = trimmed ? slugify(trimmed) : '';
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

export class DeleteRefusedError extends Error {
  constructor() {
    super('This training can no longer be deleted — it is running or has a model on Civitai.');
  }
}

/** Delete a training, re-checking `canDeleteRun` against the live workflow so a stale list can't
 *  cancel a run that has since started, or strand a model created since the list loaded. */
export async function deleteTraining(
  client: OrchestratorClient,
  workflowId: string
): Promise<void> {
  const {
    data: current,
    error: getError,
    response,
  } = await getWorkflow({ client, path: { workflowId } });
  // Already gone (another tab, a double click) is the outcome the caller asked for.
  if (response?.status === 404) return;
  if (!current) throw new Error(`delete: workflow not found (${describeSubmitError(getError)})`);
  const row = workflowToRow(current);
  if (!row || !canDeleteRun(row)) throw new DeleteRefusedError();

  const { error, response: deleteResponse } = await deleteWorkflow({
    client,
    path: { workflowId },
  });
  if (error && deleteResponse?.status !== 404)
    throw new Error(`delete failed: ${describeSubmitError(error)}`);
}
