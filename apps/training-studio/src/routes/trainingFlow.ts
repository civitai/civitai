import {
  EXTRA_PARAM_FIELDS,
  LORA_TYPES,
  MODEL_CARDS,
  allowsCustomBase,
  cardByType,
  extraParamCapabilities,
  extraParamDefaults,
  isProdigy,
  teTrainingUnsupportedReason,
  MAX_NON_PRODIGY_LR,
  paramsForVersion,
  cardsForMedia,
  findByAir,
  isCardVisible,
  visibleVersions,
  versionPriceKey,
  ecosystemTakesSampleImages,
  versionStepDefault,
  versionSuffix,
  type ExtraParamField,
  type LabelType,
  type Media,
  type ModelCard,
  type ModelVersionInfo,
} from '$lib/data/trainingModels';
import type { TrainingRunPayload } from '$lib/backend';
import type { TrainingItem } from '$lib/train-core';
import {
  blockedRunMessage,
  modelUnavailability,
  type TrainingServiceStatus,
} from '$lib/service-status-core';
import type { TagExcluder } from '$lib/autolabel-exclude';

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

/** The key a version is blocked under: its checkpoint's, as a submit resolves it (an edit card reuses
 *  a base's checkpoint under its own key). */
export const versionStatusKey = (v: ModelVersionInfo): string =>
  findByAir(v.air)?.version.key ?? v.key;

/** A card is unavailable when every version this viewer can see is blocked; the note is the first one's. */
export function cardUnavailability(
  card: ModelCard,
  enabledFlags: ReadonlySet<string>,
  status: TrainingServiceStatus | null | undefined
): { reason: string | null } | null {
  if (!isCardVisible(card, enabledFlags)) return null;
  const downs = visibleVersions(card, enabledFlags).map((v) =>
    modelUnavailability(status, versionStatusKey(v))
  );
  return downs.length > 0 && downs.every((d) => d !== null) ? downs[0]! : null;
}

/** Why the selection can't start: the first run whose model is blocked (a stale tab or restored draft
 *  can still hold one), or null. */
export function blockedSelectionMessage(
  runs: Run[],
  status: TrainingServiceStatus | null | undefined
): string | null {
  for (const run of runs) {
    const v = runVersion(run);
    // The same model fields the submit sends: a custom run still names the base it was picked under.
    const message = blockedRunMessage(
      {
        ecosystem: v.ecosystem,
        modelVariant: v.modelVariant,
        version: v.version,
        model: v.air,
        customModel: isCustom(run) ? run.customAir?.trim() || undefined : undefined,
      },
      status
    );
    if (message) return message;
  }
  return null;
}

export function runVersionLabel(run: Run): string {
  if (isCustom(run)) return 'Custom';
  const card = runCard(run);
  const v = card.versions.find((x) => x.key === run.versionKey);
  return versionSuffix(card.name, v?.label);
}

/** The version choices a card offers on Select: its catalog versions, then Custom where allowed. */
export function versionOptions(
  card: ModelCard,
  enabledFlags?: ReadonlySet<string>
): { key: string; label: string }[] {
  return [
    ...visibleVersions(card, enabledFlags).map((v) => ({ key: v.key, label: v.label })),
    ...(allowsCustomBase(card) ? [{ key: CUSTOM_VERSION_KEY, label: 'Custom' }] : []),
  ];
}

/** A run on the card's first version the viewer can see (`enabledFlags` omitted → `versions[0]`),
 *  skipping a version that is down when `status` is given and another one is up. */
export function newRun(
  card: ModelCard,
  enabledFlags?: ReadonlySet<string>,
  status?: TrainingServiceStatus | null
): Run {
  const visible = visibleVersions(card, enabledFlags);
  const first =
    visible.find((v) => !modelUnavailability(status, versionStatusKey(v))) ?? visible[0];
  if (!first) throw new Error(`Base-model card ${card.type} has no version this viewer can pick`);
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

export type DatasetFilter = 'all' | 'labeled' | 'unlabeled' | 'mature' | 'failed';

/** File-browser order — natural (`clip2` before `clip10`) and case-insensitive. A zip's entry order is
 *  whatever the archiver wrote (a tester reported theirs arriving sorted by video duration; their zip
 *  wasn't inspected), which made a failed upload impossible to place against the user's own folder. */
export const compareFileNames: (a: string, b: string) => number = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
}).compare;

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
  /** Why the last auto-label submit for this image was refused, shown on the tile. */
  labelError?: string;
  /** The label text this item ARRIVED with (a zip's .txt, a reused dataset's caption), verbatim.
   *  A label-format switch re-applies this instead of discarding it and re-auto-labeling — wiping
   *  a user's own caption files on a mode toggle is how tester data got silently destroyed. */
  sourceLabel?: string;
  /** SHA-256 of the file's bytes, when the item came from a local file — edit pairs group by it. */
  hash?: string;
  /** The workflow that produced a blob-backed item whose URL needs an authenticated fetch (a
   *  generation's edit source), so `backend().datasetBlob` can read its bytes. */
  sourceWorkflowId?: string;
  tags: string[];
  caption: string;
}

/** Start one auto-label pass over `targets`. Each step is charged, so every target is marked tried
 *  here, at submit, rather than when its result lands — a tile whose result never maps back can't be
 *  resent by the drain. Results map back by position, not tile id: when two tiles shared an id, the
 *  second was never marked and was resent every pass until the user's Buzz ran out. */
export function startLabelPass(targets: Img[]) {
  const byKey = new Map(targets.map((t, i) => [String(i), t]));
  for (const t of targets) Object.assign(t, { labeling: true, labelTried: true });
  const items = [...byKey].map(([key, t]) => ({ key, mediaUrl: t.blobUrl ?? '' }));
  return { byKey, items };
}

/** An image counts toward the trainable dataset once its bytes are uploaded and it passed the scan. */
export function isTrainable(img: Img): boolean {
  return img.status === 'uploaded';
}

export const isLabeled = (img: Img) => img.tags.length > 0 || img.caption.trim().length > 0;

/** Whether auto-label can read this image's media. A reused run's items (Train again, Reuse a dataset)
 *  only hold a browser-local `blob:` preview URL, which the labeler can't fetch and the submit refuses. */
export const canAutoLabelImage = (img: Pick<Img, 'blobUrl'>) =>
  !!img.blobUrl?.startsWith('https://');

/** Trainable images an auto-label pass may send. `skipTried` leaves out images auto-label already
 *  attempted (the drain); `focusId` is the card whose inline editor is open. */
export function autoLabelTargets(
  images: Img[],
  opts: { skipLabeled: boolean; skipTried: boolean; focusId: number | null }
): Img[] {
  return images.filter(
    (i) =>
      isTrainable(i) &&
      canAutoLabelImage(i) &&
      !i.labeling &&
      i.id !== opts.focusId &&
      !(opts.skipTried && i.labelTried) &&
      !(opts.skipLabeled && isLabeled(i))
  );
}

/** Trainable images auto-label can't read, which keep the manual editor. */
export const handLabelOnlyCount = (images: Img[]) =>
  images.filter((i) => isTrainable(i) && !canAutoLabelImage(i)).length;

export function isFailed(img: Img): boolean {
  return img.status === 'blocked' || img.status === 'error';
}

/** The training-data `air` reference for a blob-backed item (a generation / reused dataset). The
 *  orchestrator accepts a full `https://…/v2/consumer/blobs/{key}.ext` URL but rejects a generation's
 *  bare blob id and a host-less path — so use the blob's own URL with the presigned query stripped (the
 *  extension must survive for the media-type check; the signature isn't needed server-side). */
export function blobAirFromUrl(url: string): string {
  return url.split('?')[0];
}

/** A dataset item's bytes, for a zip: an upload's own File, else its URLs — a reused or hydrated item's
 *  `previewUrl` is the local object URL already fetched — and, once those have expired, `readBlob`
 *  (the authenticated read) for an item that names the workflow it came from. */
export async function imgBytes(
  img: Img,
  readBlob?: (air: string, workflowId: string) => Promise<Blob>
): Promise<Blob> {
  if (img.file) return img.file;
  for (const url of [img.previewUrl, img.blobUrl]) {
    if (!url) continue;
    const res = await fetch(url).catch(() => null);
    if (res?.ok) return res.blob();
  }
  const air = img.blobId ?? img.blobUrl;
  if (readBlob && air && img.sourceWorkflowId) return readBlob(air, img.sourceWorkflowId);
  throw new Error(`${img.name} unavailable`);
}

/** "1 pair", "3 pairs". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

/** A `NumericInput` as a `type="number"` binding's getter: blank reads as `null`, which is what Svelte
 *  reads back from the element while it holds text that isn't a number yet (`1e`, `1e-` on the way to
 *  `1e-4`). Returning `''` there makes Svelte think the value changed and clear what is being typed. */
export const numberInputValue = (value: NumericInput): number | string | null =>
  value === '' ? null : value;

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

/** LoRA file size per unit of network dim, in MB, from the median size of published trainings. Size is
 *  linear in dim but the per-dim cost depends on the architecture, so only measured cards are listed. */
const LORA_MB_PER_DIM: Partial<Record<string, number>> = {
  sdxl: 6.8,
  illustrious: 6.8,
  pony: 6.8,
  flux: 10.25,
  sd15: 1.125,
};

/** " At dim 32 the file is about 218MB (≈6.8MB per dim)." for a measured card, else ''. */
export function networkDimSizeHint(cardType: string, dim: NumericInput): string {
  const mbPerDim = LORA_MB_PER_DIM[cardType];
  const n = Number(dim);
  if (!mbPerDim || dim === '' || !Number.isFinite(n) || n <= 0) return '';
  const perDim = Math.round(mbPerDim * 10) / 10;
  return ` At dim ${n} the file is about ${Math.round(n * mbPerDim)}MB (≈${perDim}MB per dim).`;
}

/** A param's help text for a run: the model's recommended value filled in, and for network dim the file
 *  size at the value the user has entered. */
export function paramHelpText(
  field: keyof RunParams,
  cardType: string,
  defaults: RunParams,
  current: RunParams
): string {
  const text = PARAM_HELP[field].replace('{recommended}', paramDisplay(defaults[field]));
  return field === 'networkDim' ? text + networkDimSizeHint(cardType, current.networkDim) : text;
}

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
export function cardFromPrice(
  prices: Record<string, number>,
  cardType: string,
  enabledFlags?: ReadonlySet<string>
): number | null {
  const card = cardByType(cardType);
  const first = card && visibleVersions(card, enabledFlags)[0];
  if (card && first && first !== card.versions[0])
    return prices[versionPriceKey(cardType, first.key)] ?? null;
  return cardBaseQuote(prices, cardType) ?? null;
}

/** One run's "from" quote: its own version's, where the sweep quoted it, else the card's. */
function runFromPrice(prices: Record<string, number>, run: Run): number | null {
  const card = cardByType(run.cardType);
  const own =
    card && run.versionKey !== card.versions[0]?.key
      ? prices[versionPriceKey(run.cardType, run.versionKey)]
      : undefined;
  return own ?? cardFromPrice(prices, run.cardType);
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
    const runPrice = runFromPrice(prices, run);
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
export function defaultRunParams(run: Run, trigger = '', loraType = ''): RunParams {
  const d = paramsForVersion(runCard(run), run.versionKey, loraType);
  const x = extraParamDefaults(runCard(run), run.versionKey, !!trigger.trim());
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

/** Why the run's text-encoder rate is locked at 0, or undefined when its model can train it. */
export const teLockReason = (run: Run): string | undefined =>
  teTrainingUnsupportedReason(runVersion(run).ecosystem, runCard(run).name);
export const teLocked = (run: Run): boolean => teLockReason(run) !== undefined;

// The orchestrator's AI-Toolkit input has no `resolution` and drops the one we send.
const RESOLUTION_LOCK_REASON =
  "AI-Toolkit doesn't accept a training resolution, so this setting has no effect.";

/** Why a param can't be edited for a run, or undefined when it can. */
export const paramLockReason = (run: Run, field: keyof RunParams): string | undefined =>
  field === 'textEncoderLr'
    ? teLockReason(run)
    : field === 'resolution'
    ? RESOLUTION_LOCK_REASON
    : undefined;

/** The learning rates after an optimizer change, as the main trainer couples them: Prodigy runs at
 *  1, and so does a text encoder rate that is on; a locked one goes to 0 and an off (0) one stays off,
 *  so a model that defaults TE off doesn't start training it. Switching away puts a Prodigy-level rate back to the
 *  model's recommendation and leaves a rate the user picked alone. */
export function optimizerLrParams(
  run: Run,
  params: RunParams
): Pick<RunParams, 'unetLr' | 'textEncoderLr'> {
  const { unetLr, textEncoderLr } = params;
  if (isProdigy(params.optimizer))
    return {
      unetLr: '1',
      textEncoderLr: teLocked(run) ? '0' : Number(textEncoderLr) > 0 ? '1' : textEncoderLr,
    };
  const defaults = defaultRunParams(run);
  const reset = (v: NumericInput, d: NumericInput) => (Number(v) >= MAX_NON_PRODIGY_LR ? d : v);
  return {
    unetLr: reset(unetLr, defaults.unetLr),
    textEncoderLr: reset(textEncoderLr, defaults.textEncoderLr),
  };
}

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
 *  run can't use (a locked param, an unsupported extra) never count. */
export function paramDeviations(
  run: Run,
  params: RunParams,
  labelMode: LabelType,
  trigger = '',
  loraType = ''
): ParamDeviation[] {
  const defaults = defaultRunParams(run, trigger, loraType);
  const caps = runExtraCapabilities(run, labelMode);
  const out: ParamDeviation[] = [];
  for (const field of Object.keys(defaults) as (keyof RunParams)[]) {
    if (paramLockReason(run, field)) continue;
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
  /** The input image an image-conditioned sample is rendered from (`runTakesSampleImages`). */
  image?: SampleImage;
}

/** An uploaded sample input image. `url` is the scanned blob's media URL — what the orchestrator
 *  conditions the sample on, the same reference auto-labeling sends it. */
export interface SampleImage {
  url: string;
  name: string;
}

export const MAX_SAMPLE_PROMPTS = 6;

/** The list with one more, empty, prompt row (an id past every existing one), or unchanged at the cap.
 *  Empty, not example text: whatever the row holds is submitted unless the user rewrites it. */
export function addSamplePrompt(prompts: SamplePrompt[]): SamplePrompt[] {
  if (prompts.length >= MAX_SAMPLE_PROMPTS) return prompts;
  const id = Math.max(-1, ...prompts.map((p) => p.id)) + 1;
  return [...prompts, { id, text: '' }];
}

/** The filled sample prompts, trimmed. An added row starts empty, and an empty sample prompt is not a
 *  test image anyone asked for. */
export function filledPrompts(texts: string[]): string[] {
  return texts.map((t) => t.trim()).filter((t) => t.length > 0);
}

/** The sample prompts a run is submitted with: the filled ones, or the rows as they are when none is
 *  filled. Blank prompts generate no images either way; an all-blank list keeps the shape every
 *  trainer has always sent rather than an empty array no submit path has been seen to accept. */
export function submittedPrompts(texts: string[]): string[] {
  const filled = filledPrompts(texts);
  return filled.length ? filled : texts;
}

/** Whether a run trains an edit LoRA from before/after pairs. Every run in a selection agrees — the
 *  Select step won't mix them, since the two datasets don't share a shape. */
export const runTrainsPairs = (run: Run): boolean => runCard(run).pairs === true;

/** Whether `card` can join a sweep led by `primary`: one dataset feeds every run, so they must agree on
 *  its label format and on whether it is pairs. */
export function sweepCompatible(card: ModelCard, primary: ModelCard): boolean {
  return labelOptions(card).includes(primary.label) && !!card.pairs === !!primary.pairs;
}

/** Whether a run's samples can be rendered from input images (edit LoRAs). A Custom run resolves to
 *  its card's primary version, so it follows that ecosystem like every other run-level check. */
export const runTakesSampleImages = (run: Run): boolean =>
  ecosystemTakesSampleImages(runVersion(run).ecosystem);

/** The rows that are submitted: the filled ones, or all of them when none is (`submittedPrompts`). */
function submittedRows(prompts: SamplePrompt[]): SamplePrompt[] {
  const filled = prompts.filter((p) => p.text.trim().length > 0);
  return filled.length ? filled : prompts;
}

/** Why the sample input images can't be submitted as they stand, or null. The orchestrator pairs
 *  `sourceImages[i]` with `prompts[i]`, so either every submitted prompt has an image or none does —
 *  and an image on a blank row would be dropped with the row. */
export function sampleImagesProblem(prompts: SamplePrompt[]): string | null {
  if (prompts.some((p) => p.image && !p.text.trim()))
    return 'A sample with an input image needs a prompt describing the edit.';
  const rows = submittedRows(prompts);
  const withImage = rows.filter((p) => p.image).length;
  if (withImage > 0 && withImage < rows.length)
    return 'Add an input image to every sample prompt, or remove them all.';
  return null;
}

/** The input images a run's samples are rendered from, index-aligned to its submitted prompts — or
 *  undefined when the samples are text-only (no image set, or a run whose model can't take them).
 *  Throws on a `sampleImagesProblem` rather than quietly submitting the run text-only. */
export function submittedSampleImages(run: Run, prompts: SamplePrompt[]): string[] | undefined {
  if (!runTakesSampleImages(run)) return undefined;
  const problem = sampleImagesProblem(prompts);
  if (problem) throw new Error(problem);
  const urls = submittedRows(prompts).flatMap((p) => (p.image ? [p.image.url] : []));
  return urls.length ? urls : undefined;
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

/** The label text a format switch leaves on an image. The current text comes first (it carries
 *  hand-edits); the imported source label is only the fallback for a cleared field. 'relabel' clears
 *  the text for auto-label to refill, except on source-labeled items (the dialog promises they survive)
 *  and on tiles auto-label can't read, which nothing would re-label. */
export function labelTextAfterSwitch(
  img: Img,
  prev: LabelType,
  choice: 'convert' | 'relabel'
): string {
  const source = img.sourceLabel?.trim();
  const kept = labelString(img, prev) || source || '';
  return choice === 'relabel' && !source && canAutoLabelImage(img) ? '' : kept;
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

/** The Data step's tag filter: an image matches when it carries every `include` tag and none of the
 *  `exclude` tags, compared case-insensitively so a typed `Dress` finds the tagger's `dress`. */
export type TagFilter = { include: string[]; exclude: string[] };
export function matchesTagFilter(tags: string[], { include, exclude }: TagFilter): boolean {
  const have = new Set(tags.map((t) => t.toLowerCase()));
  return (
    include.every((t) => have.has(t.toLowerCase())) &&
    !exclude.some((t) => have.has(t.toLowerCase()))
  );
}
/** `filter` with the tags in `text` added to one side. A tag lives on one side only, so adding it to
 *  one takes it off the other. */
export function withFilterTags(filter: TagFilter, text: string, side: keyof TagFilter): TagFilter {
  const added = splitTags(text);
  const keys = new Set(added.map((t) => t.toLowerCase()));
  const other = side === 'include' ? 'exclude' : 'include';
  const kept = filter[side].filter((t) => !keys.has(t.toLowerCase()));
  return {
    [side]: [...kept, ...added],
    [other]: filter[other].filter((t) => !keys.has(t.toLowerCase())),
  } as TagFilter;
}

/** `tags` plus the tags typed or pasted in `text`, in order, skipping any already present. */
export function withTags(tags: string[], text: string): string[] {
  const additions = splitTags(text).filter((t) => !tags.includes(t));
  return additions.length ? [...tags, ...additions] : tags;
}

/** labelString's inverse — one definition so a mode round-trip can't corrupt labels. */
export function parseLabel(text: string, mode: LabelType): { tags: string[]; caption: string } {
  const t = text.trim();
  return mode === 'tag' ? { tags: splitTags(t), caption: '' } : { tags: [], caption: t };
}

/** Where an auto-label result goes relative to the label an image already has. */
export type LabelPosition = 'after' | 'before' | 'replace';

/** An image's label after an auto-label result lands. Only the dataset format's field reaches
 *  training (labelString), so a tagger result on a caption dataset — or a caption on a tag dataset —
 *  is written into that field, which is how one .txt ends up holding both. `exclude` filters tagger
 *  output only. An empty result keeps the label. */
export function mergeAutoLabel(
  img: Pick<Img, 'tags' | 'caption'>,
  result: { tags?: string[]; caption?: string },
  format: LabelType,
  position: LabelPosition,
  exclude: TagExcluder
): { tags: string[]; caption: string } {
  const newTags = [...new Set(result.tags ?? [])].filter((t) => !exclude(t));
  const newCaption = result.caption?.trim() ?? '';

  if (format === 'tag') {
    const incoming = newTags.length ? newTags : splitTags(newCaption);
    if (!incoming.length) return { tags: img.tags, caption: img.caption };
    if (position === 'replace') return { tags: incoming, caption: img.caption };
    const [first, second] = position === 'after' ? [img.tags, incoming] : [incoming, img.tags];
    return { tags: [...new Set([...first, ...second])], caption: img.caption };
  }

  const incoming = newTags.length ? newTags.join(', ') : newCaption;
  const existing = img.caption.trim();
  if (!incoming) return { tags: img.tags, caption: img.caption };
  if (position === 'replace' || !existing) return { tags: img.tags, caption: incoming };
  // A retry must not stack a second copy. Whole lines: a new result may be a substring of an old one.
  if (`\n${existing}\n`.includes(`\n${incoming}\n`))
    return { tags: img.tags, caption: img.caption };
  const caption = position === 'after' ? `${existing}\n${incoming}` : `${incoming}\n${existing}`;
  return { tags: img.tags, caption };
}

// Number('') is 0, not NaN, so a cleared field needs its own check or a cleared LR would train at 0.
function num(value: NumericInput, fallback: NumericInput): number {
  const n = typeof value === 'string' && !value.trim() ? NaN : Number(value);
  return Number.isFinite(n) ? n : Number(fallback);
}

/** Assemble the Start payload: one run per training run, each carrying the shared uploaded-blob dataset
 *  (labels resolved by the dataset's single label type), the chosen params, prompts, trigger, and the
 *  metadata the reconnect list/detail read back. Params arrive as strings from the Review inputs. An
 *  edit LoRA passes its pairs as path-placed `items` (`pairItems`), which replace the image list. */
/** One confirm covers every run of a sweep: they train on the same dataset. */
export function stampMature(
  runs: TrainingRunPayload[],
  matureAck: boolean,
  matureCount: number
): TrainingRunPayload[] {
  return runs.map((run) => ({
    ...run,
    ...(matureAck ? { matureAck: true } : {}),
    meta: { ...run.meta, matureCount },
  }));
}

export function buildTrainingRuns(
  selection: Selection,
  images: Img[],
  trigger: string,
  name: string,
  launched: LaunchedRun[],
  prompts: SamplePrompt[],
  currencies: string[],
  labelMode: LabelType,
  edit?: { items: TrainingItem[]; pairs: number }
): TrainingRunPayload[] {
  const mode = labelMode;
  const items = edit
    ? edit.items
    : images
        .filter((i) => i.status === 'uploaded' && !!i.blobId)
        .map((i) => ({ air: i.blobId!, caption: labelString(i, mode) }));
  const t = trigger.trim();

  return launched.map(({ run, params }) => {
    const version = runVersion(run);
    const caps = runExtraCapabilities(run, labelMode);
    // Fields the run can't use — a locked TE rate, tag-only fields on a caption dataset, image-only
    // ones on video — go out as 0/off whatever the form holds, so a value edited before a model or
    // label-mode switch can't ride into a run that hangs or misreads it.
    const tags = caps.shuffleTokens.supported;
    // A cleared field falls back to the model's default, with LRs taken for the chosen optimizer (Prodigy ~1).
    const defaults = defaultRunParams(run, t);
    const d = {
      ...defaults,
      ...optimizerLrParams(run, { ...defaults, optimizer: params.optimizer }),
    };
    return {
      ecosystem: version.ecosystem,
      modelVariant: version.modelVariant,
      version: version.version,
      engine: version.engine,
      model: version.air,
      customModel: isCustom(run) ? run.customAir?.trim() : undefined,
      steps: params.steps,
      epochs: params.epochs,
      unetLr: num(params.unetLr, d.unetLr),
      textEncoderLr: teLocked(run) ? 0 : num(params.textEncoderLr, d.textEncoderLr),
      networkDim: num(params.networkDim, d.networkDim),
      networkAlpha: num(params.networkAlpha, d.networkAlpha),
      resolution: num(params.resolution, d.resolution),
      batchSize: num(params.batchSize, d.batchSize),
      lrScheduler: params.lrScheduler,
      optimizer: params.optimizer,
      shuffleTokens: tags && params.shuffleTokens,
      keepTokens: tags ? Math.max(0, Math.round(num(params.keepTokens, d.keepTokens))) : 0,
      minSnrGamma: caps.minSnrGamma.supported ? num(params.minSnrGamma, d.minSnrGamma) : undefined,
      noiseOffset: caps.noiseOffset.supported ? num(params.noiseOffset, d.noiseOffset) : 0,
      flipAugmentation: caps.flipAugmentation.supported && params.flipAugmentation,
      trigger: t,
      items,
      ...(edit ? { editTraining: true } : {}),
      prompts: submittedPrompts(prompts.map((p) => p.text)),
      sourceImages: submittedSampleImages(run, prompts),
      currencies,
      meta: {
        name: name.trim() || t || selection.loraType,
        media: selection.media,
        loraType: selection.loraType,
        cardType: run.cardType,
        versionKey: run.versionKey,
        imageCount: edit?.pairs ?? items.length,
        trigger: t,
      },
    };
  });
}
