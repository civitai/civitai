import { queueSeverityRank, tracksLastActioned, URGENT_SEVERITY_RANK } from './queue-thresholds';

export type AttentionItem = {
  section: string;
  label: string;
  path: string;
  count: number | null;
  countKey?: string;
  informational?: boolean;
  /** It, or a tab it sums, could not be counted: `count` is a floor, or `null` when nothing was. */
  partial?: boolean;
};

/** Below every severity step: a queue with no threshold sorts after those that have one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Every queue with work in it, worst first, split at the queue's own threshold: `over` holds the ones
 * at or past their warning step, `rest` everything else with work. Within each, furthest over the
 * threshold first, then longest since anyone worked it, then the biggest.
 *
 * A tracked queue with no recent action ranks as the stalest. A queue with no last-actioned source,
 * or a map that has not loaded, ranks after every known time rather than as stale, so a missing
 * signal never outranks a real one. Empty and informational queues are left out; a queue that could
 * not be fully counted stays in, so an unread count never reads as a clear queue.
 */
export function needsAttention(
  items: AttentionItem[],
  lastActioned: Record<string, { at: string }> | null
): { over: AttentionItem[]; rest: AttentionItem[] } {
  const lastWorked = (item: AttentionItem) => {
    if (!lastActioned || !tracksLastActioned(item.countKey)) return Infinity;
    const known = lastActioned[item.countKey];
    return known ? Date.parse(known.at) : -Infinity;
  };
  const ranked = items
    .filter((item) => !item.informational && (!!item.count || !!item.partial))
    .map((item) => ({
      item,
      rank: item.countKey ? queueSeverityRank(item.countKey, item.count) ?? UNRANKED : UNRANKED,
      last: lastWorked(item),
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (a.last === b.last ? 0 : a.last < b.last ? -1 : 1) ||
        (b.item.count ?? 0) - (a.item.count ?? 0)
    );
  return {
    over: ranked.filter((r) => r.rank <= URGENT_SEVERITY_RANK).map((r) => r.item),
    rest: ranked.filter((r) => r.rank > URGENT_SEVERITY_RANK).map((r) => r.item),
  };
}
