import { compareCodePoints } from './extract';

/**
 * Request-time synonym grouping and tag weights for the v1 content-tag arm, a port of the vocabulary
 * miner's grouping and `kept_weights` (pinned by
 * `src/server/services/__tests__/resource-intent-tags.groups.test.ts`). The adopted V1 score reads
 * only the per-tag weights, so the miner's post-gate group ordering (`kept_groups`) is not ported.
 *
 * Groups are formed over every tag FOUND in the prompt, before the explicit-tag gate, and only then are
 * the gated tags dropped: a gated tag can head a group that holds two kept tags which are not near each
 * other, and it fixes their weight.
 */

/** The fields of one vocabulary tag that grouping reads. A tag's id is its position in the vocabulary. */
export type GroupingTag = {
  key: string;
  idf: number;
  /** Ascending ids of every other tag whose embedding is near this one. */
  near: readonly number[];
};

/** The distinct ids, by descending idf, ties by key in code-point order. */
function requestOrder(tagIds: Iterable<number>, tags: readonly GroupingTag[]): number[] {
  const ids = [...new Set(tagIds)];
  const bad = ids.filter((i) => !Number.isInteger(i) || i < 0 || i >= tags.length);
  if (bad.length) throw new Error(`tag ids not in the vocabulary: ${bad.slice(0, 5).join(', ')}`);
  return ids.sort(
    (a, b) => tags[b].idf - tags[a].idf || compareCodePoints(tags[a].key, tags[b].key)
  );
}

/**
 * The request's tags in synonym groups: in `requestOrder`, each tag joins the first existing group
 * (in creation order) whose head's `near` holds it, else it starts a group as its head. Groups come
 * back in creation order, each with its head first and its members in joining order.
 */
export function requestGroups(tagIds: Iterable<number>, tags: readonly GroupingTag[]): number[][] {
  const groups: number[][] = [];
  const headNear: Set<number>[] = [];
  for (const i of requestOrder(tagIds, tags)) {
    const k = headNear.findIndex((near) => near.has(i));
    if (k < 0) {
      groups.push([i]);
      headNear.push(new Set(tags[i].near));
    } else groups[k].push(i);
  }
  return groups;
}

function foundGroups(
  foundIds: Iterable<number>,
  keptIds: Iterable<number>,
  tags: readonly GroupingTag[]
) {
  const found = new Set(foundIds);
  const extra = [...new Set(keptIds)].filter((i) => !found.has(i));
  if (extra.length)
    throw new Error(`kept ids not among the found ids: ${extra.slice(0, 5).join(', ')}`);
  return requestGroups(found, tags);
}

/**
 * Each kept tag's weight: the idf of its group's head divided by the group's size, both taken over the
 * FOUND tags. The gate removes tags and never re-splits a weight. The map iterates in group creation
 * order then member order, which is the order the prototype summed weighted terms in.
 */
export function keptWeights(
  foundIds: Iterable<number>,
  keptIds: Iterable<number>,
  tags: readonly GroupingTag[]
): Map<number, number> {
  const kept = new Set(keptIds);
  const w = new Map<number, number>();
  for (const g of foundGroups(foundIds, kept, tags))
    for (const i of g) if (kept.has(i)) w.set(i, tags[g[0]].idf / g.length);
  return w;
}
