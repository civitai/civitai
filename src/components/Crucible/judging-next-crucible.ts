export type CrucibleCyclePoint = { id: number; createdAt: Date };

const time = (date: Date) => new Date(date).getTime();

// The server's order: createdAt desc, id desc.
const comesAfter = (item: CrucibleCyclePoint, from: CrucibleCyclePoint) =>
  time(item.createdAt) < time(from.createdAt) ||
  (time(item.createdAt) === time(from.createdAt) && item.id < from.id);

/**
 * The crucible "Next" moves to from `from`, in a list in server order. Steps past `from` and wraps,
 * so repeated presses walk the whole list rather than bouncing between the newest two. A `from`
 * missing from the list (caught up there) resumes at its place in the order. Null when the list
 * holds nothing but `from`.
 */
export function pickNextCrucible<T extends CrucibleCyclePoint>(
  list: T[],
  from: CrucibleCyclePoint
): T | null {
  const index = list.findIndex((item) => item.id === from.id);
  if (index >= 0) return list.length > 1 ? list[(index + 1) % list.length] : null;
  return list.find((item) => comesAfter(item, from)) ?? list[0] ?? null;
}

export type CrucibleJudgingWeightPoint = { endAt: Date | null; remainingPairs: number };

const DAY_MS = 24 * 60 * 60 * 1000;
// An open-ended crucible counts as this far from closing.
const NO_END_DAYS = 30;

/** Closing sooner and more pairs left both raise the odds; sqrt keeps a huge crucible from always winning. */
export function judgingWeight({ endAt, remainingPairs }: CrucibleJudgingWeightPoint, now: number) {
  if (remainingPairs <= 0) return 0;
  const daysLeft = endAt ? Math.max(0, (time(endAt) - now) / DAY_MS) : NO_END_DAYS;
  return Math.sqrt(remainingPairs) / (1 + daysLeft);
}

/** A random crucible for "Start Judging", weighted by `judgingWeight`. Null for an empty list. */
export function pickWeightedCrucible<T extends CrucibleJudgingWeightPoint>(
  list: T[],
  { now = Date.now(), random = Math.random }: { now?: number; random?: () => number } = {}
): T | null {
  const weights = list.map((item) => judgingWeight(item, now));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return list[0] ?? null;
  let roll = random() * total;
  for (let i = 0; i < list.length; i++) {
    roll -= weights[i];
    if (roll < 0) return list[i];
  }
  return list[list.length - 1];
}
