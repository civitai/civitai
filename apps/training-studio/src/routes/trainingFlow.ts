import {
  CUSTOM_MODEL_SURCHARGE,
  LORA_TYPES,
  MODEL_CARDS,
  cardByType,
  cardsForMedia,
  type Media,
  type ModelCard,
} from '$lib/data/trainingModels';

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
  file: File;
  previewUrl: string;
  mediaType: Media;
  status: ImgStatus;
  /** Upload fraction 0–1, driven by the XHR progress event. */
  progress: number;
  blobId?: string;
  blobUrl?: string;
  /** A block reason or upload error, shown on the tile. */
  message?: string;
  tags: string[];
  caption: string;
}

/** An image counts toward the trainable dataset once its bytes are uploaded and it passed the scan. */
export function isTrainable(img: Img): boolean {
  return img.status === 'uploaded';
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

/** A run + its params, handed to the Results step when training starts. */
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
