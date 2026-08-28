import {
  CUSTOM_MODEL_SURCHARGE,
  LORA_TYPES,
  MODEL_CARDS,
  START_PRICE,
  cardByType,
  type ModelCard,
} from '$lib/data/trainingModels';

export const CUSTOM_VERSION_KEY = 'custom';
export const MAX_RUNS = 5;

/** One planned training run: a base-model card + a chosen version (or Custom). */
export interface Run {
  cardType: string;
  versionKey: string;
}

/** Client-side selection carried across the flow. Nothing here is persisted until Start. */
export interface Selection {
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
  return { cardType: card.type, versionKey: first.key };
}

/** The recommended base-model card for a LoRA type (falls back defensively). */
export function recCard(loraTypeId: string): ModelCard {
  const t = LORA_TYPES.find((x) => x.id === loraTypeId) ?? LORA_TYPES[0]!;
  return cardByType(t.rec) ?? MODEL_CARDS[0]!;
}
