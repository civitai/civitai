import {
  LAB_LABELS,
  type LabEntityType,
  type LabLabel,
  type PromptKey,
} from '../text-scan-lab/types';
import { LABEL_ORDER } from './expected';

export type RuleStateEntry = { id: number; versionId: number | null; enabled: boolean };

export type LiveState = {
  promptIds: Record<string, number>;
  model: string;
  thinking: boolean;
  ruleStateHash: string | null;
};

export type BaselineState = 'fresh' | 'running' | 'stale' | 'none';

export const harnessKeyOf = (key: PromptKey): string =>
  key === 'base' ? 'base' : key.slice('label:'.length);

export const promptKeyOf = (harnessKey: string): PromptKey =>
  harnessKey === 'base' ? 'base' : (`label:${harnessKey}` as PromptKey);

export const labelsOf = (entityTypes: readonly LabEntityType[]): LabLabel[] =>
  LABEL_ORDER.filter((label) => entityTypes.some((type) => LAB_LABELS[type].includes(label)));

export function promptIdsFor(
  labels: readonly LabLabel[],
  active: Record<string, { id: number } | undefined>,
  overridden: readonly string[] = []
): Record<string, number> | PromptKey {
  const ids: Record<string, number> = {};
  const keys: PromptKey[] = ['base', ...labels.map((label) => `label:${label}` as PromptKey)];
  for (const key of keys) {
    if (overridden.includes(key)) {
      ids[harnessKeyOf(key)] = 0;
      continue;
    }
    const id = active[key]?.id;
    if (typeof id !== 'number') return key;
    ids[harnessKeyOf(key)] = id;
  }
  return ids;
}

export function samePromptIds(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((key, i) => key === kb[i] && a[key] === b[key]);
}

export const canonicalRuleState = (state: readonly RuleStateEntry[]) =>
  JSON.stringify([...state].sort((a, b) => a.id - b.id).map((r) => [r.id, r.versionId, r.enabled]));

export const matchesLive = (run: LiveState, live: LiveState) =>
  samePromptIds(run.promptIds, live.promptIds) &&
  run.model === live.model &&
  run.thinking === live.thinking &&
  run.ruleStateHash === live.ruleStateHash;

export function baselineState(
  latest: (LiveState & { status: string }) | null,
  live: LiveState
): BaselineState {
  if (!latest) return 'none';
  if (!matchesLive(latest, live)) return 'stale';
  if (latest.status === 'done') return 'fresh';
  return latest.status === 'queued' || latest.status === 'running' ? 'running' : 'stale';
}
