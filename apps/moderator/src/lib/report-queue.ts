/**
 * The open item's reports: its own open ones (`loadItemReports`) plus any of its reports the queue is
 * showing — a `?report=` link or a status filter can put a resolved one on screen, and it has to be
 * rulable where the moderator found it. Newest first, as the queue lists them.
 */
export function reportsForItem<R extends { id: number; entityId: number | null }>(
  open: R[],
  inView: R[],
  entityId: number
): R[] {
  const seen = new Set(open.map((r) => r.id));
  return [...open, ...inView.filter((r) => r.entityId === entityId && !seen.has(r.id))].sort(
    (a, b) => b.id - a.id
  );
}

const OPEN = new Set(['Pending', 'Processing']);

/** Whether any of the item's listed reports still needs a ruling. */
export const hasOpenReport = (reports: { status: string }[]) =>
  reports.some((r) => OPEN.has(r.status));

/**
 * The item to open once the open one has nothing left to rule: whichever now sits where it sat in the
 * queue, as ruling a report always moved the queue on to the next row. `formerIndex` is read BEFORE
 * the write — after it the queue has reloaded and the item's rows have usually left it.
 */
export function nextItemId(
  items: { entityId: number | null }[],
  formerIndex: number,
  current: number
): number | null {
  const from = Math.max(0, formerIndex);
  const rotated = [...items.slice(from), ...items.slice(0, from)];
  return rotated.find((r) => r.entityId != null && r.entityId !== current)?.entityId ?? null;
}
