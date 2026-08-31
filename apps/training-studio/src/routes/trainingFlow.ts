import {
  CUSTOM_MODEL_SURCHARGE,
  LORA_TYPES,
  MODEL_CARDS,
  START_PRICE,
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

export function startPrice(cardType: string, custom = false): number {
  return (START_PRICE[cardType] ?? 0) + (custom ? CUSTOM_MODEL_SURCHARGE : 0);
}

export function newRun(card: ModelCard): Run {
  const first = card.versions[0];
  if (!first) throw new Error(`Base-model card ${card.type} has no versions`);
  return { id: nextRunId(), cardType: card.type, versionKey: first.key };
}

/** The recommended base-model card for a LoRA type + media (falls back defensively). */
export function recCard(loraTypeId: string, media: Media): ModelCard {
  const t = LORA_TYPES.find((x) => x.id === loraTypeId);
  const recId = t?.rec[media];
  return (recId ? cardByType(recId) : undefined) ?? cardsForMedia(media)[0] ?? MODEL_CARDS[0]!;
}

/** A dataset image with its (demo) label. Owned by the flow so it survives Back/Continue. */
export interface Img {
  id: number;
  tags: string[];
  caption: string;
  done: boolean;
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

/** Per-run Buzz cost: base scales with step count but never drops below the card's "from ⚡X" floor
 * shown on Select, and the custom-model surcharge is flat (matching the "+⚡500" quoted there). Demo
 * pricing — the real number comes from the orchestrator whatif. */
export function runCost(run: Run, steps: number): number {
  const floor = START_PRICE[run.cardType] ?? 0;
  const base = Math.max(floor, Math.round(floor * (steps / 2000)));
  return base + (isCustom(run) ? CUSTOM_MODEL_SURCHARGE : 0);
}
