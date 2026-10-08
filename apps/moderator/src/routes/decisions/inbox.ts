import { itemState, type GroupRuling, type ItemState } from '$lib/decision-rulings';

/** The inbox's state filter. `all` is the absence of one. */
export const STATE_FILTERS = ['unruled', 'ruled', 'escalated', 'resolved', 'all'] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];
export const DEFAULT_STATE: StateFilter = 'unruled';
export const PAGE_SIZE = 50;

export type RulingSummary = { ruling: GroupRuling; ruledBy: number; ruledAt: Date };

/**
 * Join each source row to its current group ruling, filter by state, then page.
 *
 * 🔴 FILTER BEFORE PAGING, AND THAT IS WHY THIS RUNS HERE AND NOT IN CLICKHOUSE. The ruling lives in
 * Postgres and the item in ClickHouse; paging the item list first would drop rows the filter keeps.
 *
 * 🔴 `rulings === null` MEANS "THE STORE COULD NOT BE READ", NOT "NOTHING RULED". Then every row's
 * state is unknown, the state filter cannot be applied, and `stateApplied` says so — rendering every
 * item as `unruled` would present a missing table as a backlog.
 */
export function buildInbox<R extends { groupKey: string }>(
  rows: readonly R[],
  rulings: ReadonlyMap<string, RulingSummary> | null,
  opts: { state: StateFilter; page: number; pageSize?: number }
): {
  rows: (R & { state: ItemState | null; ruling: RulingSummary | null })[];
  total: number;
  page: number;
  stateApplied: boolean;
} {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const joined = rows.map((r) => {
    const ruling = rulings?.get(r.groupKey) ?? null;
    return { ...r, ruling, state: rulings === null ? null : itemState(ruling?.ruling ?? null) };
  });
  const stateApplied = rulings !== null && opts.state !== 'all';
  const filtered = stateApplied ? joined.filter((r) => r.state === opts.state) : joined;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  // A page past the end (a bookmark, or a filter that shrank the list) lands on the last page.
  const page = Math.min(Math.max(1, opts.page), pageCount);
  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    stateApplied,
  };
}
