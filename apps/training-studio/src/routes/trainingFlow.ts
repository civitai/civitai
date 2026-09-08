import {
  CUSTOM_MODEL_SURCHARGE,
  LORA_TYPES,
  MODEL_CARDS,
  cardByType,
  cardsForMedia,
  type LabelType,
  type Media,
  type ModelCard,
} from '$lib/data/trainingModels';
import type { TrainingRunPayload } from '$lib/train';

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
}

/** The user-facing noun for a card's label format — the single mapping from the `label`
 * discriminant, so copy/modes don't drift across the step components. */
export function labelNoun(card: ModelCard): 'tags' | 'captions' {
  return card.label === 'tag' ? 'tags' : 'captions';
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
  const t = trigger.trim();
  if (!t) return null;
  const idx = caption.toLowerCase().indexOf(t.toLowerCase());
  if (idx < 0) return null;
  return {
    before: caption.slice(0, idx),
    match: caption.slice(idx, idx + t.length),
    after: caption.slice(idx + t.length),
  };
}

/** Client-side selection carried across the flow. Nothing here is persisted until Start. */
export interface Selection {
  media: Media;
  loraType: string;
  runs: Run[];
}

export function runCard(run: Run): ModelCard {
  const c = cardByType(run.cardType);
  if (!c) throw new Error(`Unknown base-model card: ${run.cardType}`);
  return c;
}

export function isCustom(run: Run): boolean {
  return run.versionKey === CUSTOM_VERSION_KEY;
}

export function runVersionLabel(run: Run): string {
  if (isCustom(run)) return 'Custom';
  const v = runCard(run).versions.find((x) => x.key === run.versionKey);
  return v?.label ?? '';
}

export function newRun(card: ModelCard): Run {
  const first = card.versions[0];
  if (!first) throw new Error(`Base-model card ${card.type} has no versions`);
  return { id: nextRunId(), cardType: card.type, versionKey: first.key };
}

/** The recommended base-model card for a LoRA type + media (falls back defensively). */
export function recommendedCardFor(loraTypeId: string, media: Media): ModelCard {
  const t = LORA_TYPES.find((x) => x.id === loraTypeId);
  const recommendedId = t?.recommended[media];
  return (
    (recommendedId ? cardByType(recommendedId) : undefined) ??
    cardsForMedia(media)[0] ??
    MODEL_CARDS[0]!
  );
}

export type ImgStatus = 'uploading' | 'uploaded' | 'blocked' | 'error';

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
  /** A block reason or upload error, shown on the tile. */
  message?: string;
  /** True while an auto-label workflow step for this image is in flight. */
  labeling?: boolean;
  /** Set once auto-labeling has attempted this image (success, empty, or failure), so the automatic
   *  drain labels each image at most once. A failed attempt falls back to manual editing. */
  labelTried?: boolean;
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
  unetLr: string;
  textEncoderLr: string;
  networkDim: string;
  networkAlpha: string;
  lrScheduler: string;
  optimizer: string;
  resolution: string;
  batchSize: string;
}

/** A run + its chosen params, produced by the Review step's Start and fed to `buildTrainingRuns`. */
export interface LaunchedRun {
  run: Run;
  params: RunParams;
}

/** Per-run Buzz cost, scaled from the model's real "from ⚡X" orchestrator quote by the chosen step count,
 * plus the flat custom-model surcharge. `fromPrice` is the live quote for the run's card (see `FromPrices`);
 * `null` when the orchestrator couldn't price it, so the caller shows "—" rather than a guessed number.
 * Interim: the Review step should eventually re-quote the exact run config via a real whatif. */
export function runCost(fromPrice: number | undefined, run: Run, steps: number): number | null {
  if (fromPrice == null) return null;
  const base = Math.max(fromPrice, Math.round(fromPrice * (steps / 2000)));
  return base + (isCustom(run) ? CUSTOM_MODEL_SURCHARGE : 0);
}

/** The per-image label sent to the orchestrator: joined tags for tag models, the caption for caption
 *  models. The trigger word is applied server-side (triggerWord), so it isn't included here. */
export function labelString(img: Img, mode: LabelType): string {
  return mode === 'tag' ? img.tags.join(', ') : img.caption.trim();
}

// Parse a Review-step numeric field, falling back to its default when blank/garbage: Number('') is NaN,
// which JSON-serializes to null, and the orchestrator rejects a null `lr`. Fallbacks match the seeds.
function num(value: string, fallback: number): number {
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
  currencies: string[]
): TrainingRunPayload[] {
  const mode = runCard(selection.runs[0]!).label;
  const items = images
    .filter((i) => i.status === 'uploaded' && !!i.blobId)
    .map((i) => ({ air: i.blobId!, caption: labelString(i, mode) }));
  const t = trigger.trim();

  return launched.map(({ run, params }) => {
    const card = runCard(run);
    const version = card.versions.find((v) => v.key === run.versionKey) ?? card.versions[0]!;
    return {
      ecosystem: version.ecosystem,
      modelVariant: version.modelVariant,
      version: version.version,
      engine: version.engine,
      model: version.air,
      steps: params.steps,
      epochs: params.epochs,
      unetLr: num(params.unetLr, 0.0004),
      textEncoderLr: num(params.textEncoderLr, 0.00005),
      networkDim: num(params.networkDim, 32),
      networkAlpha: num(params.networkAlpha, 16),
      resolution: num(params.resolution, 1024),
      batchSize: num(params.batchSize, 2),
      lrScheduler: params.lrScheduler,
      optimizer: params.optimizer,
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
