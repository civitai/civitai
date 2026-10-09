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
