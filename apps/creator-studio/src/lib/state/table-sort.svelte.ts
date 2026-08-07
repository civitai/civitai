import { page } from '$app/state';
import { CookieState } from '$lib/state/cookie-state.svelte';
import { setPageParam } from '$lib/table-nav';
import { encodeTableSort, tableSortCookie, type TableSort } from '$lib/table-sort';

/**
 * Sort state for an analytics table, backed by the table's cookie so the SERVER sorts on first render.
 *
 * Not in the URL: these pages are per-creator private analytics, so a shared link shows the recipient their
 * own numbers — a sort param would travel without the data it describes. Pagination stays in the URL, where
 * Back walking pages is worth having.
 *
 * `tableId` is what makes a sort carry between tables that show the same columns (the models list and a
 * model's version list share one).
 */
export function tableSortState(
  tableId: string,
  canonical: () => TableSort | null | undefined,
  fallback: TableSort
) {
  const state = new CookieState<TableSort | null>(
    tableSortCookie(tableId),
    () => canonical() ?? null,
    { encode: (v) => (v ? encodeTableSort(v) : '') }
  );

  return {
    get key() {
      return state.value?.sort ?? fallback.sort;
    },
    get dir() {
      return state.value?.dir ?? fallback.dir;
    },
    async toggle(key: string) {
      const dir = this.key === key ? (this.dir === 'desc' ? 'asc' : 'desc') : 'desc';
      // Sequenced, and skipped entirely when there's no page to reset: a goto racing the cookie write's
      // invalidateAll supersedes it, so that promise never settles and the loading indicator never clears.
      if (page.url.searchParams.has('page')) await setPageParam(1);
      await state.set({ sort: key, dir });
    },
  };
}
