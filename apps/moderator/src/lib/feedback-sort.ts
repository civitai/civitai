import { clearPaging } from './paging';
import { urlWith } from './url';

/**
 * The feedback queue's column sort — the URL half.
 *
 * 🔴 SORTING IS SERVER-SIDE, AND THAT IS NOT A PREFERENCE. The list is keyset-paged at
 * `FEEDBACK_PAGE_SIZE`, so a client-side `.sort()` orders the 50 rows that happen to be loaded and
 * presents them as an ordering of the whole queue. It looks completely right on every screen — the
 * arrow points the way it should, the rows are in order — and it is wrong for any queue larger than
 * one page. There are 26 live rows today, so a client-side sort would also be INDISTINGUISHABLE from
 * a correct one until the table grows. Nothing here sorts rows; this module only reads and writes the
 * URL, and `getFeedbackList` does the ordering in SQL.
 *
 * 🔴 THE STATE LIVES IN THE URL, NOT IN A COMPONENT, AND NOT IN `replaceState`. Every successful
 * write on this page calls `invalidateAll()`, so component state is re-created under the operator the
 * instant their save lands — the same reason `?tab=` is a URL param (`feedback-tabs.ts`). And shallow
 * routing is not an option either: `replaceState` DOES NOT UPDATE `page.url` in
 * `@sveltejs/kit@2.66.0` (`runtime/client/client.js:2524-2555` stores the OLD `page.url.href` under
 * its own key), so a URL-backed control built on it reads its own state back as unchanged and is
 * inert while looking live. The column headers are real links, like the tab strip's triggers.
 */

/**
 * The sortable columns, by the header they sit under.
 *
 * 🔴 THE 📎 COLUMN IS DELIBERATELY ABSENT. Attachment count is not a column — it is
 * `images.length + (screenshotId ? 1 : 0)` derived from a JSONB blob by `feedbackAttachmentCount`.
 * Sorting it server-side means an expression over `context` on every row, with no index to serve it,
 * and — the worse half — a SECOND implementation of "how many attachments does this row have", in
 * SQL, which nothing makes agree with the TypeScript one. The count and the lightbox already share a
 * single definition for exactly that reason (see `feedbackAttachmentItems`). If this is ever wanted,
 * it wants a materialised column, not a sort key.
 */
export const FEEDBACK_SORT_COLUMNS = ['age', 'area', 'user', 'status', 'handled', 'issue'] as const;

export type FeedbackSortColumn = (typeof FEEDBACK_SORT_COLUMNS)[number];
export type FeedbackSortDirection = 'asc' | 'desc';
export type FeedbackSort = { column: FeedbackSortColumn; direction: FeedbackSortDirection };

export const FEEDBACK_SORT_PARAM = 'sort';
export const FEEDBACK_SORT_DIR_PARAM = 'dir';

/**
 * The second half of the compound keyset: the boundary row's value in the SORTED column.
 *
 * `?cursor=` still carries the row id and still means exactly what it meant before. This param is
 * what makes the pair unique — see `getFeedbackList` for why the id half can never be dropped.
 *
 * 🔴 AN ABSENT PARAM DOES NOT MEAN ONE THING — WHICH COLUMN IS SORTED DECIDES. On a column that can
 * be null (`user`, `handled`, `issue`) it means "the boundary row's value IS null", a real position
 * in the ordering, because the null block sorts last and the pager omits the param rather than
 * spelling a null. On a NOT NULL column (`age`, `area`, `status`) nothing this code writes can
 * produce that spelling, so it means the URL was edited and the server starts over at page one. The
 * `nullable` flag in `FEEDBACK_SORT_KEYS` is what holds the distinction; it is not readable from
 * here, which is why the coercion lives next to the map rather than in this module.
 */
export const FEEDBACK_CURSOR_VALUE_PARAM = 'cursorValue';

export const isFeedbackSortColumn = (value: unknown): value is FeedbackSortColumn =>
  typeof value === 'string' && (FEEDBACK_SORT_COLUMNS as readonly string[]).includes(value);

const isFeedbackSortDirection = (value: unknown): value is FeedbackSortDirection =>
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
 * Paging state that a new batch invalidates — BOTH halves of the compound cursor.
 *
 * 🔴 Dropping only `?cursor=` would leave the value half behind, and a value half from the previous
 * ordering is not a harmless leftover: it is the operand of the keyset comparison, so the first page
 * of the new ordering would silently start somewhere in the middle of it. `clearPaging` owns the
 * generic params (cursor, the trail, the image page); this adds the one this page invented.
 */
export function clearFeedbackPaging(params: URLSearchParams) {
  clearPaging(params);
  params.delete(FEEDBACK_CURSOR_VALUE_PARAM);
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
  clearFeedbackPaging(next.searchParams);
  const sort = nextFeedbackSort(parseFeedbackSort(url.searchParams), column);
  return urlWith(next, {
    [FEEDBACK_SORT_PARAM]: sort?.column ?? null,
    [FEEDBACK_SORT_DIR_PARAM]: sort?.direction ?? null,
  });
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
