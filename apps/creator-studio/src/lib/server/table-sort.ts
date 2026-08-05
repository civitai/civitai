import type { Cookies } from '@sveltejs/kit';
import { parseTableSort, tableSortCookie, type TableSort } from '$lib/table-sort';

// `null` when the creator has never sorted this table — the page falls back to its own default key.
export function readTableSort(cookies: Cookies, tableId: string): TableSort | null {
  return parseTableSort(cookies.get(tableSortCookie(tableId)));
}
