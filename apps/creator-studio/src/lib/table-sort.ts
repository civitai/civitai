// Remembered sort for the analytics tables. A cookie rather than localStorage so the SERVER knows the sort
// while rendering: localStorage is invisible during SSR, so the table would paint in default order and
// reshuffle on hydration (or need a post-load redirect to reconcile the URL).
//
// One cookie per table, written host-only (no Domain) so it stays on creator-studio.
export type TableSort = { sort: string; dir: 'asc' | 'desc' };

export const tableSortCookie = (tableId: string) => `cs-sort-${tableId}`;

// `<sort>:<dir>`. Sort keys contain ':' themselves (e.g. `channel:licenseFee`), so the direction is taken
// from the LAST colon — no separator that a key could collide with.
export function parseTableSort(raw: string | null | undefined): TableSort | null {
  if (!raw) return null;
  const at = raw.lastIndexOf(':');
  if (at <= 0) return null;
  const sort = raw.slice(0, at);
  const dir = raw.slice(at + 1);
  if (!sort || (dir !== 'asc' && dir !== 'desc')) return null;
  return { sort, dir };
}

export const encodeTableSort = (s: TableSort) => `${s.sort}:${s.dir}`;
