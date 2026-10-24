import { createHash } from 'crypto';

import {
  RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT,
  RESOURCE_INTENT_HYBRID_HEAD_MODELS,
  RESOURCE_INTENT_STAGE3_INSTRUCTIONS,
  RESOURCE_INTENT_STAGE3_NONE_DESCRIPTION,
  STAGE3_MAX_RANKED,
  type ResourceIntentCriteria,
} from '~/server/schema/resource-intent.schema';
import type { JevChoiceQuestion } from '~/server/services/ai/jev';
import type { ResourceIntentShortlistEntry } from '~/server/services/resource-intent-matcher.service';

/**
 * Stage 3 of the resource-intent primitive and the hybrid list, as pure functions.
 * This is the R4c design and the HYBRID_10 merge exactly as the offline arm screen
 * measured them; a change here is a change to what was measured.
 *
 * 🔴 KEEP THIS MODULE LIGHT, for the same reason as `resource-intent-stage1.ts`: a
 * standalone study script must be able to import it without the service's graph.
 */

export function describeStage3Option(entry: ResourceIntentShortlistEntry): string {
  return `${entry.modelName} — ${entry.versionName} (${entry.modelType}, ${entry.baseModel})`;
}

/** Positional keys `"0".."n-1"` for the entries in the order SENT, plus a described `none`. */
export function buildStage3Question(ordered: ResourceIntentShortlistEntry[]): JevChoiceQuestion {
  const options = [...ordered.map((_, i) => String(i)), 'none'];
  const optionDescriptions: Record<string, string> = {
    none: RESOURCE_INTENT_STAGE3_NONE_DESCRIPTION,
  };
  ordered.forEach((entry, i) => (optionDescriptions[String(i)] = describeStage3Option(entry)));
  return {
    id: 'resourceVersion',
    type: 'choice',
    prompt: RESOURCE_INTENT_STAGE3_INSTRUCTIONS,
    options,
    optionDescriptions,
  };
}

export function buildStage3State(
  prompt: string,
  criteria: Pick<ResourceIntentCriteria, 'role' | 'styleFamily'>
) {
  return { prompt, role: criteria.role, styleFamily: criteria.styleFamily };
}

/**
 * The two option orders stage 3 sends, as shortlist indexes: popularity (the entry's
 * position in the seed `pool`) and its exact reverse. Two orders averaged, because a
 * single Choice over a long list is biased toward its first options.
 *
 * Only the first `STAGE3_MAX_RANKED` shortlist entries are sent (the vendor's option
 * budget minus `none`); the rest score 0 in `combineStage3Answers`.
 */
export function stage3Orders(
  shortlist: readonly ResourceIntentShortlistEntry[],
  pool: readonly ResourceIntentShortlistEntry[]
): number[][] {
  const poolIndex = new Map(pool.map((entry, i) => [entry.versionId, i]));
  const popularity = shortlist
    .slice(0, STAGE3_MAX_RANKED)
    .map((entry, i) => ({ i, p: poolIndex.get(entry.versionId) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map(({ i }) => i);
  return [popularity, [...popularity].reverse()];
}

/**
 * Average each shortlist entry's probability across the orders (`distributions[k]` is
 * keyed by position in `orders[k]`) and sort by it, ties to the lower shortlist index —
 * i.e. the matcher's order. `noneProbability` is the averaged `none` mass; it ranks
 * nothing and empties nothing.
 */
export function combineStage3Answers(
  shortlistLength: number,
  orders: readonly (readonly number[])[],
  distributions: readonly Readonly<Record<string, number>>[]
): { order: number[]; noneProbability: number } {
  const summed = new Map<number, number>();
  let noneSum = 0;
  orders.forEach((order, k) => {
    const distribution = distributions[k];
    order.forEach((index, position) =>
      summed.set(index, (summed.get(index) ?? 0) + (distribution[String(position)] ?? 0))
    );
    noneSum += distribution['none'] ?? 0;
  });
  const m = orders.length;
  const order = Array.from({ length: shortlistLength }, (_, i) => ({
    i,
    p: (summed.get(i) ?? 0) / m,
  }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map(({ i }) => i);
  return { order, noneProbability: noneSum / m };
}

/**
 * The first `headSize` DISTINCT models of `head` (a later version of a placed model is
 * skipped), then `fill` in order, skipping every model already placed, until `cap`. A
 * short head is taken whole; an empty head yields `fill`'s first `cap` models.
 */
export function mergeHybrid<T extends Pick<ResourceIntentShortlistEntry, 'modelId'>>(
  head: readonly T[],
  fill: readonly T[],
  headSize: number,
  cap: number
): T[] {
  const out: T[] = [];
  const placed = new Set<number>();
  for (const entry of head) {
    if (out.length >= headSize) break;
    if (placed.has(entry.modelId)) continue;
    placed.add(entry.modelId);
    out.push(entry);
  }
  for (const entry of fill) {
    if (out.length >= cap) break;
    if (placed.has(entry.modelId)) continue;
    placed.add(entry.modelId);
    out.push(entry);
  }
  return out;
}

const fingerprintEntry = (modelId: number, versionId: number): ResourceIntentShortlistEntry => ({
  versionId,
  modelId,
  modelName: `m${modelId}`,
  versionName: `v${versionId}`,
  baseModel: 'b',
  modelType: 't',
  thumbsUpCount: 0,
});

/**
 * Hashes what the functions above PRODUCE on a fixed fixture, not a hand-kept description
 * of them, so an edit to the wording, the option format, `none`, the state keys, the
 * averaging, the tie-break or the merge moves the hash (and the cache key) without anyone
 * remembering to bump it.
 */
function stage3Fingerprint() {
  const shortlist = [fingerprintEntry(1, 11), fingerprintEntry(2, 21), fingerprintEntry(2, 22)];
  const pool = [shortlist[2], shortlist[0], shortlist[1]];
  const orders = stage3Orders(shortlist, pool);
  return {
    question: buildStage3Question(shortlist),
    state: buildStage3State('p', { role: 'style', styleFamily: 'other' }),
    orders,
    combine: [
      combineStage3Answers(shortlist.length, orders, [
        { '0': 0.5, '1': 0.25, none: 0.25 },
        { '0': 0.25, '2': 0.5, none: 0.25 },
      ]),
      combineStage3Answers(shortlist.length, orders, [
        { '0': 0.6, '1': 0.35, none: 0.05 },
        { '1': 0.35, none: 0.65 },
      ]),
    ],
    merge: mergeHybrid(shortlist, [fingerprintEntry(3, 31), ...pool], 2, 3).map((e) => e.versionId),
    headModels: RESOURCE_INTENT_HYBRID_HEAD_MODELS,
    baseDeepPageLimit: RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT,
    maxRanked: STAGE3_MAX_RANKED,
  };
}

export const RESOURCE_INTENT_STAGE3_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(stage3Fingerprint()))
  .digest('hex');
