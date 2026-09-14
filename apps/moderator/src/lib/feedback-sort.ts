import { CURSOR_VALUE_PARAM, clearPaging } from './paging';
import { urlWith } from './url';

/**
 * The feedback queue's column sort — the URL half.
 *
 * 🔴 NOTHING HERE SORTS ROWS, AND NOTHING ELSE ON THE CLIENT MAY EITHER. The list is keyset-paged at
 * `FEEDBACK_PAGE_SIZE`, so a `.sort()` over the loaded page orders one page and presents it as an
 * ordering of the queue: the arrow points the right way, the visible rows are in order, and it is
 * wrong for any queue past its first page. Below that size it is INDISTINGUISHABLE from correct, so
 * it will not be caught by looking. `getFeedbackList` does the ordering in SQL.
 *
 * 🔴 THE STATE IS IN THE URL, NOT IN A COMPONENT AND NOT IN `replaceState`. Every successful write on
 * this page calls `invalidateAll()`, which re-creates component state under the operator — the same
 * reason `?tab=` is a param (`feedback-tabs.ts`). And `replaceState` DOES NOT UPDATE `page.url` in
 * `@sveltejs/kit@2.66.0` (`runtime/client/client.js:2524-2555` stores the OLD `page.url.href` under
 * its own key), so a control built on shallow routing reads its own state back unchanged and is inert
 * while looking live.
 */

/**
 * The sortable columns, by the header they sit under.
 *
 * 🔴 THE 📎 COLUMN IS DELIBERATELY ABSENT. The attachment count is derived from a JSONB blob by
 * `feedbackAttachmentCount`, so a SQL ordering needs an unindexed expression over `context` AND a
 * SECOND implementation of that arithmetic, which nothing makes agree with the first — the count and
 * the lightbox share one definition for exactly that reason. It wants a materialised column, not a
 * sort key.
 */
export const FEEDBACK_SORT_COLUMNS = ['age', 'area', 'user', 'status', 'handled', 'issue'] as const;

export type FeedbackSortColumn = (typeof FEEDBACK_SORT_COLUMNS)[number];
export type FeedbackSortDirection = 'asc' | 'desc';
export type FeedbackSort = { column: FeedbackSortColumn; direction: FeedbackSortDirection };

export const FEEDBACK_SORT_PARAM = 'sort';
export const FEEDBACK_SORT_DIR_PARAM = 'dir';

/**
 * The compound keyset's value half, re-exported from `$lib/paging` — which owns it, so that
 * `clearPaging` clears it for every page that turns a batch over. `?cursor=` still carries the row
 * id and still means exactly what it meant before.
 *
 * 🔴 AN ABSENT PARAM DOES NOT MEAN ONE THING — WHICH COLUMN IS SORTED DECIDES. On a column that can
 * be null (`user`, `handled`, `issue`) it means "the boundary row's value IS null", a real position
 * in the ordering, because the null block sorts last and the pager omits the param rather than
 * spelling a null. On a NOT NULL column (`age`, `area`, `status`) nothing this code writes can
 * produce that spelling, so it means the URL was edited and the server starts over at page one. The
 * `nullable` flag in `FEEDBACK_SORT_KEYS` is what holds the distinction; it is not readable from
 * here, which is why the coercion lives next to the map rather than in this module.
 */
export const FEEDBACK_CURSOR_VALUE_PARAM = CURSOR_VALUE_PARAM;

export const isFeedbackSortColumn = (value: unknown): value is FeedbackSortColumn =>
  typeof value === 'string' && (FEEDBACK_SORT_COLUMNS as readonly string[]).includes(value);

export const isFeedbackSortDirection = (value: unknown): value is FeedbackSortDirection =>
  value === 'asc' || value === 'desc';

/**
 * `?sort=`/`?dir=` as a sort, or `null` for the default ordering.
 *
 * 🔴 AN ALLOWLIST MEMBERSHIP TEST, NEVER A PASS-THROUGH. Both params are typed on the URL by whoever
 * is holding the keyboard, and the column ends up naming a SQL identifier — so an unknown value has
 * to be refused here rather than reach the query builder. `getFeedbackList` refuses a second time on
 * its own map; neither layer ever interpolates the value into SQL.
 *
 * An unknown column degrades to the default ordering (the whole sort is dropped, not just the
 * column), and an unknown DIRECTION on a known column degrades to `asc` — the first state of the
 * cycle, which is what a bare `?sort=area` from a hand-written link should mean. Same `.catch()`
 * contract every other param on this page has: a bad value must never 500 a queue nobody can then
 * open.
 */
export function parseFeedbackSort(params: URLSearchParams): FeedbackSort | null {
  const column = params.get(FEEDBACK_SORT_PARAM);
  if (!isFeedbackSortColumn(column)) return null;
  const direction = params.get(FEEDBACK_SORT_DIR_PARAM);
  return { column, direction: isFeedbackSortDirection(direction) ? direction : 'asc' };
}

/**
 * The tri-state cycle: ascending → descending → none, and none → ascending.
 *
 * Clicking a DIFFERENT column always starts that column at ascending rather than inheriting the
 * direction of the one before it — the previous column's direction was a statement about a different
 * ordering, and carrying it over means the first click on a new column lands on a state the operator
 * did not choose.
 */
export function nextFeedbackSort(
  current: FeedbackSort | null,
  column: FeedbackSortColumn
): FeedbackSort | null {
  if (current?.column !== column) return { column, direction: 'asc' };
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}

/**
 * The `href` a column header carries.
 *
 * 🔴 IT CLEARS PAGING. A cursor names a position in ONE ordering; carried into another it points at a
 * row that is no longer the boundary, and the page that comes back is neither the first page nor the
 * next one — it is arbitrary, and it looks like data.
 *
 * ⚠️ `?open=` SURVIVES on purpose, and this function must never write it — `feedbackOpenHref` is the
 * single choke point that sets that param, and a tripwire enforces it. Re-sorting does not change
 * WHICH reports are in the view, only their order, so the panel the operator is reading stays open.
 * If the row falls onto a later page the existing `openVisible` branch says so; closing it outright
 * would throw away what they were reading in order to avoid a message that already exists.
 */
export function feedbackSortHref(url: URL, column: FeedbackSortColumn): string {
  const next = new URL(url);
  clearPaging(next.searchParams);
  const sort = nextFeedbackSort(parseFeedbackSort(url.searchParams), column);
  return urlWith(next, {
    [FEEDBACK_SORT_PARAM]: sort?.column ?? null,
    [FEEDBACK_SORT_DIR_PARAM]: sort?.direction ?? null,
  });
}

/**
 * The `href` for the next page, carrying BOTH halves of the keyset.
 *
 * 🔴 THE VALUE HALF IS ALWAYS WRITTEN — SET WHEN THERE IS ONE, DELETED WHEN THERE IS NOT. Leaving it
 * alone when the new boundary's value is null is not a no-op: the CURRENT url already carries the
 * PREVIOUS page's value, so the link ships a boundary belonging to a row that is no longer the
 * boundary. That is the ordinary transition INTO the trailing null block, not a hand-edited URL —
 * `handled` is null on every untriaged row — and the server then reads a non-null boundary, whose
 * predicate admits the whole null block with no id bound. The same page comes back, its own boundary
 * row included, and `Next →` never advances.
 *
 * 🔴 `searchParams.set`, NOT `urlWith`, for that half. `urlWith` deletes on an EMPTY STRING as well as
 * on null — the right rule for a filter control, where empty means "not filtering", and the wrong one
 * here, where an empty string is a VALUE and absence means "the boundary row's value is null".
 *
 * `?open=` is cleared for the reason `FeedbackFilters` clears it: it can name a row this page does not
 * contain, and a panel that silently does not render is worse than one that was closed.
 */
export function feedbackNextPageHref(url: URL, cursor: number, value: string | null): string {
  const next = new URL(urlWith(url, { cursor, open: null }), url);
  if (value === null) next.searchParams.delete(FEEDBACK_CURSOR_VALUE_PARAM);
  else next.searchParams.set(FEEDBACK_CURSOR_VALUE_PARAM, value);
  return next.pathname + next.search;
}

/**
 * The `aria-sort` value for a header cell.
 *
 * Every sortable header carries one — `none` on the inactive ones is what tells a screen reader the
 * column is sortable but unsorted, where an absent attribute says nothing at all.
 */
export function feedbackSortAria(
  current: FeedbackSort | null,
  column: FeedbackSortColumn
): 'ascending' | 'descending' | 'none' {
  if (current?.column !== column) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}

/** The arrow next to an active header, and an empty string on every other column. */
export function feedbackSortMarker(
  current: FeedbackSort | null,
  column: FeedbackSortColumn
): string {
  if (current?.column !== column) return '';
  return current.direction === 'asc' ? '↑' : '↓';
}
