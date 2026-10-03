import { findPii } from './safety';
import { readJson } from './store';
import type { GoldRow, ManifestItem, Split } from './types';

export class LeakageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeakageError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type TimeSplitWindows = { devStartDaysAgo: number; testStartDaysAgo: number };

/** Foundation #eval: train before day −30, dev −30 to −15, sealed test −15 to now. */
export const DEFAULT_TIME_SPLIT: TimeSplitWindows = { devStartDaysAgo: 30, testStartDaysAgo: 15 };

export function timeSplit(ts: string, now: Date, windows = DEFAULT_TIME_SPLIT): Split {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) throw new Error(`unparseable timestamp ${ts}`);
  if (t >= now.getTime() - windows.testStartDaysAgo * DAY_MS) return 'test';
  if (t >= now.getTime() - windows.devStartDaysAgo * DAY_MS) return 'dev';
  return 'train';
}

export type GroupIsolationResult = {
  items: ManifestItem[];
  /** Items removed from a later split because their group already sat in an earlier one. */
  dropped: { itemId: string; groupKey: string; split: Split }[];
};

const SPLIT_ORDER: Record<Split, number> = { train: 0, dev: 1, test: 2 };

/**
 * A group key may live in one split only. By default a violation throws; with
 * `dropLaterOverlap`, each group keeps its earliest split and the later-split
 * items are dropped and returned so the report can count them.
 */
export function enforceGroupIsolation(
  items: readonly ManifestItem[],
  opts: { dropLaterOverlap?: boolean } = {}
): GroupIsolationResult {
  const earliest = new Map<string, Split>();
  for (const item of items) {
    const seen = earliest.get(item.groupKey);
    if (seen === undefined || SPLIT_ORDER[item.split] < SPLIT_ORDER[seen]) {
      earliest.set(item.groupKey, item.split);
    }
  }
  const kept: ManifestItem[] = [];
  const dropped: GroupIsolationResult['dropped'] = [];
  for (const item of items) {
    if (earliest.get(item.groupKey) === item.split) kept.push(item);
    else dropped.push({ itemId: item.itemId, groupKey: item.groupKey, split: item.split });
  }
  if (dropped.length > 0 && !opts.dropLaterOverlap) {
    const groups = new Set(dropped.map((d) => d.groupKey)).size;
    throw new LeakageError(
      `${groups} group(s) span more than one split (${dropped.length} later-split items); pass dropLaterOverlap to drop them`
    );
  }
  return { items: kept, dropped };
}

/**
 * A rebuild keeps every item it has already assigned, verbatim. A time split
 * is relative to `now`, so re-deriving it daily would walk items from test into
 * dev; and a removed image's row may be gone from the source by the next build
 * while its prediction still needs its manifest entry.
 */
export function mergeManifest(
  existing: readonly ManifestItem[],
  incoming: readonly ManifestItem[],
  opts: { dropConflicts?: boolean } = {}
): { items: ManifestItem[]; added: number; dropped: GroupIsolationResult['dropped'] } {
  const known = new Set(existing.map((i) => i.itemId));
  const groupSplit = new Map(existing.map((i) => [i.groupKey, i.split]));
  const fresh: ManifestItem[] = [];
  const dropped: GroupIsolationResult['dropped'] = [];
  for (const item of incoming) {
    if (known.has(item.itemId)) continue;
    const held = groupSplit.get(item.groupKey);
    if (held !== undefined && held !== item.split) {
      dropped.push({ itemId: item.itemId, groupKey: item.groupKey, split: item.split });
    } else {
      fresh.push(item);
    }
  }
  if (dropped.length > 0 && !opts.dropConflicts) {
    throw new LeakageError(
      `${dropped.length} new item(s) belong to a group already assigned to another split; pass dropConflicts to drop them`
    );
  }
  return { items: [...existing, ...fresh], added: fresh.length, dropped };
}

export type EvalIndex = { itemIds: string[]; groupKeys: string[] };

/** Read by other tools (the LoRA manifest builder), so the file name carries its schema version. */
export const EVAL_INDEX_FILE = 'eval-index.v1.json';
const EVAL_INDEX_SCHEMA = 'civitai.decision-eval.eval-index';

export type EvalIndexFileV1 = EvalIndex & {
  schema: typeof EVAL_INDEX_SCHEMA;
  version: 1;
  nodeId: string;
  updatedAt: string;
};

export function serializeEvalIndex(nodeId: string, index: EvalIndex, now: Date): EvalIndexFileV1 {
  return { schema: EVAL_INDEX_SCHEMA, version: 1, nodeId, updatedAt: now.toISOString(), ...index };
}

export function parseEvalIndex(json: unknown, nodeId: string): EvalIndex {
  const f = json as Partial<EvalIndexFileV1> | null;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (
    !f ||
    f.schema !== EVAL_INDEX_SCHEMA ||
    f.version !== 1 ||
    f.nodeId !== nodeId ||
    !strings(f.itemIds) ||
    !strings(f.groupKeys)
  ) {
    throw new LeakageError(`eval index is not a v1 index for node ${nodeId}; refusing to trust it`);
  }
  return { itemIds: f.itemIds as string[], groupKeys: f.groupKeys as string[] };
}

/** Only ever grows: an id that was once eval stays out of training for good. */
export function buildEvalIndex(items: readonly ManifestItem[], previous?: EvalIndex): EvalIndex {
  const evalItems = items.filter((i) => i.split !== 'train');
  return {
    itemIds: [...new Set([...(previous?.itemIds ?? []), ...evalItems.map((i) => i.itemId)])].sort(),
    groupKeys: [
      ...new Set([...(previous?.groupKeys ?? []), ...evalItems.map((i) => i.groupKey)]),
    ].sort(),
  };
}

export const EXCLUSIONS_FILE = 'excluded.v1.json';
const EXCLUSIONS_SCHEMA = 'civitai.decision-eval.excluded';

export type ExclusionsFileV1 = {
  schema: typeof EXCLUSIONS_SCHEMA;
  version: 1;
  nodeId: string;
  itemIds: string[];
};

/**
 * Exclusion is sticky: an item excluded once (say, CSAM-reported after it was
 * sampled) leaves the manifest and can never come back, even though the
 * manifest otherwise keeps every item it has assigned.
 */
export function applyExclusions(
  items: readonly ManifestItem[],
  previous: readonly string[],
  newlyExcluded: readonly string[]
): { items: ManifestItem[]; excluded: string[]; removed: number } {
  const excluded = [...new Set([...previous, ...newlyExcluded])].sort();
  const set = new Set(excluded);
  const kept = items.filter((i) => !set.has(i.itemId));
  return { items: kept, excluded, removed: items.length - kept.length };
}

export function serializeExclusions(nodeId: string, itemIds: string[]): ExclusionsFileV1 {
  return { schema: EXCLUSIONS_SCHEMA, version: 1, nodeId, itemIds };
}

export function parseExclusions(json: unknown, nodeId: string): string[] {
  const f = json as Partial<ExclusionsFileV1> | null;
  if (
    !f ||
    f.schema !== EXCLUSIONS_SCHEMA ||
    f.version !== 1 ||
    f.nodeId !== nodeId ||
    !Array.isArray(f.itemIds) ||
    !f.itemIds.every((x) => typeof x === 'string')
  ) {
    throw new Error(`exclusions file is not a v1 file for node ${nodeId}; refusing to trust it`);
  }
  return f.itemIds;
}

export function loadExclusions(path: string, nodeId: string): string[] {
  const json = readJson<unknown>(path);
  return json === undefined ? [] : parseExclusions(json, nodeId);
}

/**
 * `trainer-dev` is the imajev trainer's own checkpoint-selection partition. It
 * is carved from the train window and is train-side for leakage purposes.
 */
export type TrainPartition = 'train' | 'trainer-dev';

export type TrainCandidate = Omit<ManifestItem, 'split'> & { partition: TrainPartition };

/**
 * Candidates come from an external JSONL file. A number never equals the index's string ids, and
 * the refusals below name an item by id, so ids are checked first.
 */
function assertTrainCandidates(candidates: readonly TrainCandidate[]): void {
  candidates.forEach((c, i) => {
    const at = `training row ${i + 1}`;
    for (const key of ['itemId', 'groupKey'] as const) {
      if (typeof c[key] !== 'string' || !c[key]) {
        throw new LeakageError(`${at}: ${key} must be a non-empty string`);
      }
    }
    const pii = findPii({ id: c.itemId, group_key: c.groupKey });
    if (pii) {
      throw new LeakageError(
        `${at}: its ${pii.field} is ${pii.kind}-shaped; a node's ids must not carry personal data`
      );
    }
    if (c.partition !== 'train' && c.partition !== 'trainer-dev') {
      throw new LeakageError(`${at}: partition must be train or trainer-dev`);
    }
    if (
      !c.state ||
      typeof c.state !== 'object' ||
      Array.isArray(c.state) ||
      !Object.values(c.state).every((v) => typeof v === 'string')
    ) {
      throw new LeakageError(`${at}: state must be an object of strings`);
    }
  });
}

/**
 * The LoRA leakage control: no training row, in either trainer partition, may
 * share an item or a group with anything a dev or test split has ever held.
 */
export function buildTrainManifest(
  candidates: readonly TrainCandidate[],
  index: EvalIndex,
  excludedIds: readonly string[] = []
): TrainCandidate[] {
  assertTrainCandidates(candidates);
  const excluded = new Set(excludedIds);
  const barred = candidates.filter((c) => excluded.has(c.itemId));
  if (barred.length > 0) {
    throw new LeakageError(
      `${barred.length} training row(s) are excluded items (first: item ${barred[0].itemId}); refusing to build`
    );
  }
  const ids = new Set(index.itemIds);
  const groups = new Set(index.groupKeys);
  const leaks = candidates.filter((c) => ids.has(c.itemId) || groups.has(c.groupKey));
  if (leaks.length > 0) {
    throw new LeakageError(
      `${leaks.length} training row(s) collide with the eval index (first: item ${leaks[0].itemId}, partition ${leaks[0].partition}); refusing to build`
    );
  }
  return [...candidates];
}

/**
 * A labeller's current label replaces their earlier one for the same item, so a
 * correction wins. Rows without a labeller are kept by identity, since several may
 * legitimately exist per item. Rows the source no longer yields are kept.
 */
export function mergeGold(existing: readonly GoldRow[], current: readonly GoldRow[]): GoldRow[] {
  const key = (r: GoldRow) =>
    r.labeler === undefined
      ? `row:${JSON.stringify(r)}`
      : `labeler:${JSON.stringify([r.itemId, r.labeler])}`;
  const merged = new Map<string, GoldRow>();
  for (const row of existing) merged.set(key(row), row);
  for (const row of current) merged.set(key(row), row);
  return [...merged.values()];
}

/**
 * How several labels for one item become gold. `majority` drops ties, which with
 * two labellers drops every disagreement — the hardest items — so a node with a
 * designated labeller, or one that treats disagreement as a class, says so here.
 */
export type GoldPolicy =
  | { kind: 'majority' }
  | { kind: 'primary'; labeler: string }
  | { kind: 'disagreement-as'; label: string };

export type ResolvedGold = {
  gold: Map<string, string>;
  /** Items the policy could not resolve; left out of gold and counted in the report. */
  ties: string[];
  /** First two labels per multi-labelled item, disagreements included, for the human-human baseline. */
  humanPairs: Array<[string, string]>;
  /** (first human, final) pairs where a first decision was recorded. */
  firstVsFinal: Array<[string, string]>;
};

function majorityOf(list: readonly GoldRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of list) counts.set(row.gold, (counts.get(row.gold) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

export function resolveGold(
  rows: readonly GoldRow[],
  policy: GoldPolicy = { kind: 'majority' }
): ResolvedGold {
  const byItem = new Map<string, GoldRow[]>();
  for (const row of rows) {
    const list = byItem.get(row.itemId) ?? [];
    list.push(row);
    byItem.set(row.itemId, list);
  }
  const gold = new Map<string, string>();
  const ties: string[] = [];
  const humanPairs: Array<[string, string]> = [];
  const firstVsFinal: Array<[string, string]> = [];
  for (const [itemId, list] of byItem) {
    if (list.length >= 2) humanPairs.push([list[0].gold, list[1].gold]);
    let label: string | null;
    if (policy.kind === 'primary') {
      label = list.find((r) => r.labeler === policy.labeler)?.gold ?? majorityOf(list);
    } else if (policy.kind === 'disagreement-as') {
      label = new Set(list.map((r) => r.gold)).size === 1 ? list[0].gold : policy.label;
    } else {
      label = majorityOf(list);
    }
    if (label === null) {
      ties.push(itemId);
      continue;
    }
    gold.set(itemId, label);
    const first = list.find((r) => r.firstHumanLabel !== undefined)?.firstHumanLabel;
    if (first !== undefined) firstVsFinal.push([first, label]);
  }
  return { gold, ties, humanPairs, firstVsFinal };
}
