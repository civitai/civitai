import { clearPaging } from './paging';
import type { PermissionSet } from './permissions';

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

/** How every queue moves between items: the queue column holds its scroll and focus. */
export const QUEUE_NAV = { noScroll: true, keepFocus: true } as const;

/**
 * An item's URL with the queue's filters and page carried over, and what belonged to the last view
 * dropped — a single-report `?report=` view, and the item's own pagers (`clearPaging`). Every queue's
 * "open this item" and "move on" goes through it; eight copies had grown up in four queues.
 */
export function itemHref(path: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete('report');
  clearPaging(params);
  return params.size ? `${path}?${params}` : path;
}

/**
 * The queue moving on once the open item has nothing left to rule, as ruling a report always moved it
 * on to the next row. `capture` at submit — after the write the queue has reloaded and the item's rows
 * have usually left it — and `advance` on success, reading the reloaded list.
 */
export function advanceAfterRuling<I extends { entityId: number | null }>(opts: {
  items: () => I[];
  currentId: () => number | null | undefined;
  /** Whether the open item still has a report to rule; while it does the queue stays. */
  hasOpen: () => boolean;
  /** Opens the item — the page's own `goto(itemHref(...), QUEUE_NAV)`. */
  open: (id: number) => void;
}) {
  let formerIndex = -1;
  return {
    capture() {
      const id = opts.currentId();
      formerIndex = opts.items().findIndex((r) => r.entityId === id);
    },
    advance() {
      const id = opts.currentId();
      if (id == null || opts.hasOpen()) return;
      const next = nextItemId(opts.items(), formerIndex, id);
      if (next != null) opts.open(next);
    },
  };
}

/**
 * What a moderator may do to a report's content and its owner, from their action grants. Ruling on the
 * report and its notes need only the queue itself. Read once per view, so the grid, the owner panel
 * and `ReadOnlyNotice` cannot disagree; every action checks the same ids again server-side.
 */
export function reportActionGrants(grants: PermissionSet) {
  return { images: !!grants['image.moderate'], strike: !!grants['user.strike'] };
}
export type ReportActionGrants = ReturnType<typeof reportActionGrants>;
