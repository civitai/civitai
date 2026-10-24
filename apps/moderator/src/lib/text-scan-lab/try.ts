import type { CheckInput } from './input';
import { verdictsDiffer } from './labels';
import {
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  PROMPT_KEYS,
  type LabEntityType,
  type LabField,
  type LabLabel,
  type LabScanResult,
  type PromptChanges,
  type PromptKey,
} from './types';

export type TrySubject = {
  key: string;
  title: string;
  fields: LabField[];
  entityId: number | null;
  authorId: number | null;
};

export type TryItem = TrySubject & { current: LabScanResult; edited: LabScanResult | null };

export type TrySide = { system: string | null };

export type TryResult = {
  tried: true;
  entityType: LabEntityType;
  labels: readonly LabLabel[];
  notice: string | null;
  items: TryItem[];
  skipped: { entityId: number; error: string }[];
  current: TrySide;
  edited: TrySide | null;
};

export function sourceTypeOf(
  parsed: CheckInput,
  as: { lookupAs: LabEntityType; profileAs: LabEntityType }
): LabEntityType | null {
  switch (parsed.kind) {
    case 'ids':
      return as.lookupAs;
    case 'entity':
      return parsed.entityType;
    case 'user':
      return as.profileAs;
    default:
      return null;
  }
}

export function judgeCandidates(
  source: LabEntityType | null,
  edited: readonly PromptKey[]
): LabEntityType[] {
  const pool = source === null ? LAB_ENTITY_TYPES : [source];
  const labels = edited.flatMap((key) =>
    key === 'base' ? [] : [key.slice('label:'.length) as LabLabel]
  );
  // A type none of whose labels the drafts edit would judge both sides alike and show no change.
  const using = pool.filter((type) => LAB_LABELS[type].some((label) => labels.includes(label)));
  return [...(using.length ? using : pool)];
}

export const editedPromptKeys = (prompts: PromptChanges): PromptKey[] =>
  PROMPT_KEYS.filter((key) => key in prompts);

export const itemChanged = (item: TryItem, labels: readonly LabLabel[]) =>
  item.edited !== null && labels.some((label) => verdictsDiffer(label, item.current, item.edited!));

/** A result shows the effect of the drafts it was run with; once they change (a save, an edit), it no longer does. */
export const runIsStale = (ranWith: string | null, drafts: string) =>
  ranWith !== null && ranWith !== drafts;
