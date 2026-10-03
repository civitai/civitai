import {
  EXTRA_PARAM_FIELDS,
  LORA_TYPES,
  MODEL_CARDS,
  TE_TRAINING_UNSUPPORTED,
  cardByType,
  extraParamCapabilities,
  extraParamDefaults,
  paramsForVersion,
  cardsForMedia,
  versionStepDefault,
  versionSuffix,
  type ExtraParamField,
  type LabelType,
  type Media,
  type ModelCard,
  type ModelVersionInfo,
} from '$lib/data/trainingModels';
import type { TrainingRunPayload } from '$lib/backend';

export const CUSTOM_VERSION_KEY = 'custom';
export const MAX_RUNS = 5;

let runSeq = 0;
/** Stable client id for a run — keeps `{#each}` keyed by identity, not index (duplicate
 * runs are allowed in a sweep, so nothing else is unique). */
export const nextRunId = () => ++runSeq;

/** One planned training run: a base-model card + a chosen version (or Custom). */
export interface Run {
  id: number;
  cardType: string;
  versionKey: string;
  /** For the `Custom…` version: the AIR of a Civitai model to train on, pasted by the user. */
  customAir?: string;
  /** The picked model's display name when `customAir` came from the host's model picker; cleared
   *  when the AIR is edited by hand, so it never labels an AIR it doesn't describe. */
  customName?: string;
}

/** A pasted custom-model AIR looks usable (urn:air:…). Not exhaustive — the orchestrator is the real check. */
export function isValidAir(air: string): boolean {
  return /^urn:air:[^\s]+$/.test(air.trim());
}

/** The user-facing noun for a card's label format — the single mapping from the `label`
 * discriminant, so copy/modes don't drift across the step components. */
export function labelNoun(card: ModelCard): 'tags' | 'captions' {
  return card.label === 'tag' ? 'tags' : 'captions';
}

/** The label formats a card can train on — both for a `bothLabels` model (the Data step offers a choice),
 *  else just its single `label`. `card.label` is always the default (first). */
export function labelOptions(card: ModelCard): LabelType[] {
  return card.bothLabels ? [card.label, card.label === 'tag' ? 'caption' : 'tag'] : [card.label];
}

// Trigger-word display rules, shared by the tile previews and the label editor: the trigger is only
// prepended to a label that doesn't already contain it, and highlighted in place where it does. Matching
// is case-insensitive.
export function isTriggerTag(trigger: string, tag: string): boolean {
  const t = trigger.trim();
  return t.length > 0 && tag.toLowerCase() === t.toLowerCase();
}
export function tagsHaveTrigger(trigger: string, tags: string[]): boolean {
  return tags.some((tag) => isTriggerTag(trigger, tag));
}
/** Split a caption around the first case-insensitive occurrence of the trigger, or null if absent. */
export function captionTriggerHit(
  trigger: string,
  caption: string
): { before: string; match: string; after: string } | null {
  const hit = findTrigger(trigger, caption);
  if (!hit) return null;
  return {
    before: caption.slice(0, hit.index),
    match: caption.slice(hit.index, hit.index + hit.length),
    after: caption.slice(hit.index + hit.length),
  };
}

/** Where the trigger word occurs in a text — case-insensitive, as a whole term (a trigger `art` is
 *  not inside `portrait`). The ONE matcher behind the caption highlight and the sample-prompt check,
 *  so the Data step and the Review step can't disagree about whether a text carries the trigger. */
export function findTrigger(
  trigger: string,
  text: string
): { index: number; length: number } | null {
  const t = trigger.trim();
  if (!t) return null;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'iu').exec(text);
  return m ? { index: m.index + m[1]!.length, length: m[2]!.length } : null;
}

/** Client-side selection carried across the flow. Nothing here is persisted until Start. */
export interface Selection {
  media: Media;
  loraType: string;
  runs: Run[];
  /** True once the user picked a base model by hand. While false the primary run follows the type's
   *  recommendation as the type changes; once true a type change leaves the model alone. */
  userPickedModel?: boolean;
}

export function runCard(run: Run): ModelCard {
  const c = cardByType(run.cardType);
  if (!c) throw new Error(`Unknown base-model card: ${run.cardType}`);
  return c;
}

export function isCustom(run: Run): boolean {
  return run.versionKey === CUSTOM_VERSION_KEY;
}

/** The run's effective catalog version: the chosen key, or the card's default when the key names
 *  no catalog entry (the Custom key never does). The single resolution the submit payload, the
 *  engine lookup and the host model-picker pre-filter all share — divergence here means the
 *  picker filters against one ecosystem while the submit trains against another. */
export function runVersion(run: Run): ModelVersionInfo {
  const card = runCard(run);
  return card.versions.find((v) => v.key === run.versionKey) ?? card.versions[0]!;
}

export function runVersionLabel(run: Run): string {
  if (isCustom(run)) return 'Custom';
  const card = runCard(run);
  const v = card.versions.find((x) => x.key === run.versionKey);
  return versionSuffix(card.name, v?.label);
}

export function newRun(card: ModelCard): Run {
  const first = card.versions[0];
  if (!first) throw new Error(`Base-model card ${card.type} has no versions`);
  return { id: nextRunId(), cardType: card.type, versionKey: first.key };
}

/** The recommended base-model card for a LoRA type + media (falls back defensively). */
export function recommendedCardFor(
  loraTypeId: string,
  media: Media,
  enabledFlags?: ReadonlySet<string>
): ModelCard {
  const t = LORA_TYPES.find((x) => x.id === loraTypeId);
  const recommendedId = t?.recommended[media];
  const cards = cardsForMedia(media, enabledFlags);
  // Never seed a gated-off card: prefer the recommended one if visible, else the first visible card, and
  // only fall back to the unfiltered catalog if a media somehow has no visible cards at all.
  return (
    (recommendedId ? cards.find((c) => c.type === recommendedId) : undefined) ??
    cards[0] ??
    cardsForMedia(media)[0] ??
    MODEL_CARDS[0]!
  );
}

export type ImgStatus = 'uploading' | 'uploaded' | 'blocked' | 'error';

export type DatasetFilter = 'all' | 'labeled' | 'unlabeled' | 'mature';

let imgSeq = 0;
/** Client id for a dataset tile. Module-level because the flow keeps `images` across Back/Continue
 *  while the Data step remounts. */
export const nextImgId = () => ++imgSeq;

/** A dataset item: its source file, upload/scan state against the orchestrator, and its label.
 *  Owned by the flow so it survives Back/Continue. Once uploaded the bytes live in the orchestrator
 *  (`blobId` is the training-data reference, `blobUrl` the scanned media URL); labels are edited
 *  locally for now (auto-label lands next). */
export interface Img {
  id: number;
  /** The source file for an uploaded-from-disk item; absent for items pulled from an existing orchestrator
   *  blob (a generation or a reused dataset), which are already uploaded. */
  file?: File;
  /** Display name (filename, or a synthetic label for blob-backed items). */
  name: string;
  previewUrl: string;
  mediaType: Media;
  status: ImgStatus;
  /** Upload fraction 0–1, driven by the XHR progress event. */
  progress: number;
  blobId?: string;
  blobUrl?: string;
  /** The scan's rating, when known — a mature one means Blue Buzz can't pay for a non-member's run. */
  nsfwLevel?: string;
  /** A block reason or upload error, shown on the tile. */
  message?: string;
  /** True while an auto-label workflow step for this image is in flight. */
  labeling?: boolean;
  /** Set once auto-labeling has attempted this image (success, empty, or failure), so the automatic
   *  drain labels each image at most once. A failed attempt falls back to manual editing. */
  labelTried?: boolean;
  /** The label text this item ARRIVED with (a zip's .txt, a reused dataset's caption), verbatim.
   *  A label-format switch re-applies this instead of discarding it and re-auto-labeling — wiping
   *  a user's own caption files on a mode toggle is how tester data got silently destroyed. */
  sourceLabel?: string;
  tags: string[];
  caption: string;
}

/** An image counts toward the trainable dataset once its bytes are uploaded and it passed the scan. */
export function isTrainable(img: Img): boolean {
  return img.status === 'uploaded';
}

/** The training-data `air` reference for a blob-backed item (a generation / reused dataset). The
 *  orchestrator accepts a full `https://…/v2/consumer/blobs/{key}.ext` URL but rejects a generation's
 *  bare blob id and a host-less path — so use the blob's own URL with the presigned query stripped (the
 *  extension must survive for the media-type check; the signature isn't needed server-side). */
export function blobAirFromUrl(url: string): string {
  return url.split('?')[0];
}

/** Per-run training parameters chosen on the Review step (mirrors the prod trainer's fields). */
export interface RunParams {
  steps: number;
  epochs: number;
  unetLr: NumericInput;
  textEncoderLr: NumericInput;
  networkDim: NumericInput;
  networkAlpha: NumericInput;
  lrScheduler: string;
  optimizer: string;
  resolution: NumericInput;
  batchSize: NumericInput;
  shuffleTokens: boolean;
  keepTokens: NumericInput;
  minSnrGamma: NumericInput;
  noiseOffset: NumericInput;
  flipAugmentation: boolean;
}

/** What a `type="number"` input's binding hands back: the number, or '' when cleared. Stored as-is —
 *  round-tripping through `String()` makes Svelte rewrite the field on every keystroke, and a
 *  decimal being typed (`0.0`) collapses to `0` before the next digit lands. */
export type NumericInput = string | number;

/** Human label per param — typed against `RunParams` so a new field without one fails typecheck
 *  instead of rendering its key. */
export const PARAM_LABELS: Record<keyof RunParams, string> = {
  steps: 'Steps',
  epochs: 'Checkpoints (epochs)',
  batchSize: 'Batch size',
  unetLr: 'UNet LR',
  textEncoderLr: 'Text encoder LR',
  networkDim: 'Network dim',
  networkAlpha: 'Network alpha',
  resolution: 'Resolution',
  lrScheduler: 'LR scheduler',
  optimizer: 'Optimizer',
  shuffleTokens: 'Shuffle tags',
  keepTokens: 'Keep first tags',
  minSnrGamma: 'Min SNR gamma',
  noiseOffset: 'Noise offset',
  flipAugmentation: 'Flip augmentation',
};

/** Help text per param, written for someone doing their first LoRA. `{recommended}` is replaced
 *  with the model's own default at render time so the explanation names a number. */
export const PARAM_HELP: Record<keyof RunParams, string> = {
  steps:
    'How many optimisation steps the run makes. More steps means each image is seen more often; too many and the model memorises the dataset instead of learning it. The recommended budget for this model is {recommended}.',
  epochs:
    'How many checkpoints are saved, evenly spread over the run. Each becomes a downloadable, testable version — more checkpoints make it easier to pick the best point without changing how long training takes. Recommended: {recommended}.',
  batchSize:
    'How many images are trained on at once. Larger batches smooth out each update and use more VRAM; the ceiling is fixed per model. Recommended: {recommended}.',
  unetLr:
    'How strongly the image model (UNet / transformer) is updated per step. Too high burns in artefacts, too low under-trains. Recommended for this model: {recommended}.',
  textEncoderLr:
    'How strongly the text encoder is trained. Helps the model tie your trigger word and tags to what it sees; some architectures cannot train it at all. Recommended for this model: {recommended}.',
  networkDim:
    'The LoRA rank — its capacity. Higher values can hold more detail but make a bigger file and overfit more easily. Recommended for this model: {recommended}.',
  networkAlpha:
    'Scales the LoRA weights: the effective strength is alpha ÷ dim. Alpha equal to dim applies the learning rate as-is; a smaller alpha dampens it. Recommended: {recommended}.',
  resolution:
    'The longest edge images are scaled to for training. Higher costs VRAM and time; the range is fixed per model family. Recommended: {recommended}.',
  lrScheduler:
    'How the learning rate changes over the run: constant holds it, cosine eases it down towards the end, linear ramps it down evenly. Recommended: {recommended}.',
  optimizer:
    'The algorithm that applies each update. AdamW8Bit is the common default; Prodigy and Automagic tune their own learning rate. Recommended for this model: {recommended}.',
  shuffleTokens:
    'Randomly reorders the tags of each image every time it is seen, so the model does not learn that a tag matters more because it always comes first. Only meaningful for tag datasets.',
  keepTokens:
    'How many leading tags stay in place when tags are shuffled — set it to 1 to keep your trigger word first. Does nothing unless Shuffle tags is on.',
  minSnrGamma:
    'Weights the loss by how noisy each training step is, which stabilises SD-family training. 5 is the usual value; 0 turns it off.',
  noiseOffset:
    'Adds a small brightness/contrast offset to the training noise, which helps the model produce very dark or very bright images. 0 turns it off; large values wash out results. Recommended for this model: {recommended}.',
  flipAugmentation:
    'Randomly mirrors images horizontally to double the effective dataset. Good for symmetric subjects; keep it off for characters with asymmetric details, text, logos or handedness.',
};

/** A run + its chosen params, produced by the Review step's Start and fed to `buildTrainingRuns`. */
export interface LaunchedRun {
  run: Run;
  params: RunParams;
}

// Pony / Illustrious are SDXL-ecosystem checkpoints split into their own cards; they train at the same cost,
// so fall back to the SDXL "from" quote when the orchestrator hasn't priced them directly.
const PRICE_ALIAS: Record<string, string> = { pony: 'sdxl', illustrious: 'sdxl' };

/** The orchestrator's "from" quote for a card at the default step budget (Pony/Illustrious fall back to
 *  SDXL). `undefined` when unpriced. */
function cardBaseQuote(prices: Record<string, number>, cardType: string): number | undefined {
  const alias = PRICE_ALIAS[cardType];
  return prices[cardType] ?? (alias ? prices[alias] : undefined);
}

/** The "from" Buzz quote for one model card; null when unpriced (callers show a muted em-dash).
 *  Single source of truth for the "from" floor shown on Select. A custom base costs the same as the
 *  card's own (whatif-verified — the orchestrator has no custom-model surcharge). */
export function cardFromPrice(prices: Record<string, number>, cardType: string): number | null {
  return cardBaseQuote(prices, cardType) ?? null;
}

/** Sum the "from" floor across a selection's runs; null if any run is unpriced (callers show "—").
 *  The pre-Review estimate on Select AND Data: the "from" quote is a whatif with no `steps`, so the
 *  orchestrator already priced each card at its own default budget — which is exactly what the
 *  Review step seeds (`defaultStepsForRun`). COARSE: Review replaces this with real per-config
 *  whatif quotes (`quoteRun`); sample images are not billed separately (the quote covers them);
 *  no custom-model surcharge (whatif-verified). */
export function selectionFromTotal(prices: Record<string, number>, runs: Run[]): number | null {
  let sum = 0;
  for (const run of runs) {
    const runPrice = cardFromPrice(prices, run.cardType);
    if (runPrice == null) return null;
    sum += runPrice;
  }
  return sum;
}

/** The default step budget for a run — the main app's fixed per-base default (`aiToolkitStepDefault`
 *  parity). Dataset size does NOT scale it: repeats absorb the image count, so a big dataset lowers
 *  per-image "seen" rather than inflating steps (and price). */
export function defaultStepsForRun(run: Run): number {
  return versionStepDefault(runVersion(run).key);
}

/** A run's Review-step params from its chosen model's defaults — per run, since a sweep can mix models. */
export function defaultRunParams(run: Run): RunParams {
  const d = paramsForVersion(runCard(run), run.versionKey);
  const x = extraParamDefaults(runCard(run), run.versionKey);
  return {
    steps: defaultStepsForRun(run),
    epochs: d.epochs,
    unetLr: String(d.unetLr),
    textEncoderLr: String(d.textEncoderLr),
    networkDim: String(d.networkDim),
    networkAlpha: String(d.networkAlpha),
    lrScheduler: d.lrScheduler,
    optimizer: d.optimizer,
    resolution: String(d.resolution),
    batchSize: String(d.batchSize),
    shuffleTokens: x.shuffleTokens,
    keepTokens: String(x.keepTokens),
    minSnrGamma: String(x.minSnrGamma),
    noiseOffset: String(x.noiseOffset),
    flipAugmentation: x.flipAugmentation,
  };
}

/** Which of the extra AI-Toolkit fields a run can actually use, given the dataset's label mode. */
export function runExtraCapabilities(run: Run, labelMode: LabelType) {
  return extraParamCapabilities(runCard(run), runVersion(run), labelMode);
}

/** The text-encoder rate is locked at 0 for models whose backend can't train it. */
export const teLocked = (run: Run): boolean => TE_TRAINING_UNSUPPORTED.has(run.versionKey);

export interface ParamDeviation {
  field: keyof RunParams;
  label: string;
  value: string;
  recommended: string;
}

/** Display form of one param value — numbers as typed, booleans as On/Off. */
export function paramDisplay(value: NumericInput | boolean): string {
  return typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value);
}

/** Two param values agree when they read as the same number (so `0.00005` equals `5e-5`), else as
 *  the same string. */
function paramEquals(a: NumericInput | boolean, b: NumericInput | boolean): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}

/** Fields where the run's params differ from the model's recommendation, in form order. Fields the
 *  run can't use (a locked TE rate, an unsupported extra) never count. */
export function paramDeviations(
  run: Run,
  params: RunParams,
  labelMode: LabelType
): ParamDeviation[] {
  const defaults = defaultRunParams(run);
  const caps = runExtraCapabilities(run, labelMode);
  const out: ParamDeviation[] = [];
  for (const field of Object.keys(defaults) as (keyof RunParams)[]) {
    if (field === 'textEncoderLr' && teLocked(run)) continue;
    if (
      EXTRA_PARAM_FIELDS.includes(field as ExtraParamField) &&
      !caps[field as ExtraParamField].supported
    )
      continue;
    if (paramEquals(params[field], defaults[field])) continue;
    out.push({
      field,
      label: PARAM_LABELS[field],
      value: paramDisplay(params[field]),
      recommended: paramDisplay(defaults[field]),
    });
  }
  return out;
}

/** Identity of a run's Review params: a run whose base or version changed on Select gets fresh model
 *  defaults instead of carrying another model's numbers. */
export const runParamsKey = (run: Run): string => `${run.id}:${run.cardType}:${run.versionKey}`;

export interface SamplePrompt {
  id: number;
  text: string;
}

/** Whether a sample prompt already carries the trigger word (`findTrigger`). Always true when there
 *  is no trigger, so callers can use it directly as "nothing to warn about". */
export function promptHasTrigger(trigger: string, text: string): boolean {
  return trigger.trim().length === 0 || findTrigger(trigger, text) !== null;
}

/** The prompt with the trigger word leading it, unless it is already present. Tags and captions both
 *  take it as a leading comma-separated term — the same place the dataset's own labels carry it. */
export function withTrigger(trigger: string, text: string): string {
  const t = trigger.trim();
  if (!t || promptHasTrigger(t, text)) return text;
  const rest = text.trim();
  return rest ? `${t}, ${rest}` : t;
}

/** Sample prompts seeded from the dataset itself — 3 random labels — so the test images generated during
 *  training reflect what the model is learning. A generic prompt when the dataset carries no labels. Every
 *  seed carries the trigger word: a sample that omits it never tests whether the LoRA learned it. */
export function seedPrompts(labels: string[], trigger = ''): SamplePrompt[] {
  const pool = labels.map((l) => l.trim()).filter((l) => l.length > 0);
  const picks: string[] = [];
  while (picks.length < 3 && pool.length > 0) {
    picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  }
  return (picks.length > 0 ? picks : ['a photo']).map((text, id) => ({
    id,
    text: withTrigger(trigger, text),
  }));
}

/** The per-image label sent to the orchestrator: joined tags for tag models, the caption for caption
 *  models. The trigger word is applied server-side (triggerWord), so it isn't included here. */
export function labelString(img: Img, mode: LabelType): string {
  return mode === 'tag' ? img.tags.join(', ') : img.caption.trim();
}

/** Tag-text splitting, shared by every tag-entry path (parseLabel, the label editor, the exclude
 *  list, mass rename) — one definition so a comma/newline paste can't split differently per path.
 *  Dedupe stays at the call sites; their policies genuinely differ. */
export function splitTags(text: string): string[] {
  // Unique: `foo, foo` in a caption would otherwise reach img.tags, where chips key on the tag string.
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

/** labelString's inverse — one definition so a mode round-trip can't corrupt labels. */
export function parseLabel(text: string, mode: LabelType): { tags: string[]; caption: string } {
  const t = text.trim();
  return mode === 'tag' ? { tags: splitTags(t), caption: '' } : { tags: [], caption: t };
}

// Parse a Review-step numeric field, falling back to a safe generic value when blank/garbage: Number('') is
// NaN, which JSON-serializes to null, and the orchestrator rejects a null `lr`. The seeds are per-model
// (PARAM_DEFAULTS); this is only the last-resort fallback if a field is cleared.
function num(value: NumericInput, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Assemble the Start payload: one run per training run, each carrying the shared uploaded-blob dataset
 *  (labels resolved by the dataset's single label type), the chosen params, prompts, trigger, and the
 *  metadata the reconnect list/detail read back. Params arrive as strings from the Review inputs. */
export function buildTrainingRuns(
  selection: Selection,
  images: Img[],
  trigger: string,
  name: string,
  launched: LaunchedRun[],
  prompts: string[],
  currencies: string[],
  labelMode: LabelType
): TrainingRunPayload[] {
  const mode = labelMode;
  const items = images
    .filter((i) => i.status === 'uploaded' && !!i.blobId)
    .map((i) => ({ air: i.blobId!, caption: labelString(i, mode) }));
  const t = trigger.trim();

  return launched.map(({ run, params }) => {
    const version = runVersion(run);
    const caps = runExtraCapabilities(run, labelMode);
    // Fields the run can't use — a locked TE rate, tag-only fields on a caption dataset, image-only
    // ones on video — go out as 0/off whatever the form holds: a value edited before a model or
    // label-mode switch must not ride into a run that hangs on it or misreads it.
    const tags = caps.shuffleTokens.supported;
    return {
      ecosystem: version.ecosystem,
      modelVariant: version.modelVariant,
      version: version.version,
      engine: version.engine,
      model: version.air,
      customModel: isCustom(run) ? run.customAir?.trim() : undefined,
      steps: params.steps,
      epochs: params.epochs,
      unetLr: num(params.unetLr, 0.0004),
      textEncoderLr: teLocked(run) ? 0 : num(params.textEncoderLr, 0.00005),
      networkDim: num(params.networkDim, 32),
      networkAlpha: num(params.networkAlpha, 16),
      resolution: num(params.resolution, 1024),
      batchSize: num(params.batchSize, 2),
      lrScheduler: params.lrScheduler,
      optimizer: params.optimizer,
      shuffleTokens: tags && params.shuffleTokens,
      keepTokens: tags ? Math.max(0, Math.round(num(params.keepTokens, 0))) : 0,
      minSnrGamma: caps.minSnrGamma.supported ? num(params.minSnrGamma, 0) : undefined,
      noiseOffset: caps.noiseOffset.supported ? num(params.noiseOffset, 0) : 0,
      flipAugmentation: caps.flipAugmentation.supported && params.flipAugmentation,
      trigger: t,
      items,
      prompts,
      currencies,
      meta: {
        name: name.trim() || t || selection.loraType,
        media: selection.media,
        loraType: selection.loraType,
        cardType: run.cardType,
        versionKey: run.versionKey,
        imageCount: items.length,
        trigger: t,
      },
    };
  });
}
