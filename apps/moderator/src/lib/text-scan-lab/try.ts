import type { CheckInput } from './input';
import {
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  PROMPT_KEYS,
  type LabEntityType,
  type LabField,
  type LabLabel,
  type LabRule,
  type LabRuleOverride,
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

export type TrySide = { system: string | null; rules: LabRule[] | null };

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

// Entity types that read the same text, so a link to one can be judged as the other.
const SAME_TEXT: Partial<Record<LabEntityType, readonly LabEntityType[]>> = {
  Model: ['Model', 'ModelRules'],
  ModelRules: ['Model', 'ModelRules'],
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
  const pool = source === null ? LAB_ENTITY_TYPES : SAME_TEXT[source] ?? [source];
  const labels = edited.flatMap((key) =>
    key === 'base' ? [] : [key.slice('label:'.length) as LabLabel]
  );
  const using = pool.filter((type) => LAB_LABELS[type].some((label) => labels.includes(label)));
  return [...(using.length ? using : pool)];
}

export const editedPromptKeys = (
  prompts: PromptChanges,
  rules: readonly LabRuleOverride[]
): PromptKey[] =>
  PROMPT_KEYS.filter((key) => key in prompts || (key === 'label:modelRules' && rules.length > 0));
