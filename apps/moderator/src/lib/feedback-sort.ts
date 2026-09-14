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

export const isFeedbackSortColumn = (value: unknown): value is FeedbackSortColumn =>
  typeof value === 'string' && (FEEDBACK_SORT_COLUMNS as readonly string[]).includes(value);

export const isFeedbackSortDirection = (value: unknown): value is FeedbackSortDirection =>
  value === 'asc' || value === 'desc';

/**
 * The directions each column offers, IN CYCLE ORDER — what a click walks through before returning
 * to the default ordering. Five columns are tri-state (asc → desc → none); `age` is not.
 *
 * 🔴 `age` OFFERS ONE DIRECTION, AND ITS SECOND STATE WAS A NO-OP RATHER THAN A PREFERENCE. This
 * column sorts on `f.id` (see `FEEDBACK_SORT_KEYS` for why it is not a timestamp), and the DEFAULT
 * ordering is already `f.id DESC` — newest first, which is youngest-age first. So the "youngest
 * first" state produced byte-identical rows to no sort at all: measured against the 26 live rows,
 * the first column in the table cycled click → an arrow appeared and nothing moved, click →
 * reversed, click → the arrow vanished and nothing moved. Oldest-first is the one view the default
 * ordering cannot express, so it is the one state this column has.
 *
 * 🔴 THE DIRECTION TOKEN IS THE SERVER'S, NOT THE SCREEN'S — `age`'s single state is `asc` because
 * the SQL is `f.id ASC` (earliest arrival first), and it READS as descending because the Age cell
 * renders a duration. `READS_INVERTED` below is what turns one into the other, and it is the only
 * place that flip exists. `feedbackSortHref` writes no `?dir=` at all for a one-state column, so
 * nothing in the URL claims a direction the header contradicts.
 *
 * ⚠️ THE OTHER FIVE ARE DELIBERATELY DIFFERENT, NOT MERELY UNCHANGED. Their cells render the value
 * the server orders by, so both directions show something the default cannot. Read this table
 * rather than assuming one uniform cycle across the header strip.
 */
export const FEEDBACK_SORT_DIRECTIONS = {
  age: ['asc'],
  area: ['asc', 'desc'],
  user: ['asc', 'desc'],
  status: ['asc', 'desc'],
  handled: ['asc', 'desc'],
  issue: ['asc', 'desc'],
} as const satisfies Record<FeedbackSortColumn, readonly FeedbackSortDirection[]>;

/** The directions a column offers, widened off the `as const` so callers can search it. */
const directionsFor = (column: FeedbackSortColumn): readonly FeedbackSortDirection[] =>
  FEEDBACK_SORT_DIRECTIONS[column];

/**
 * A state this page can actually reach — a known column, in a direction that column offers.
 *
 * 🔴 THE COLUMN CHECK MUST COME FIRST, AND IT IS NOT DECORATION: the clause after it INDEXES AN
 * OBJECT LITERAL WITH THE UNTRUSTED VALUE, and `FEEDBACK_SORT_DIRECTIONS['__proto__']` is
 * `Object.prototype` while `['toString']` is a function — neither has `.includes`, so a prototype
 * key reaching that line is a `TypeError` out of a predicate, not a `false`. Short-circuiting on the
 * allowlist is what keeps the lookup total. Pinned with `__proto__`/`constructor`/`toString` in
 * `feedback-sort.test.ts` and in the service's own refusal cases.
 *
 * ⚠️ THE MIDDLE CLAUSE IS A TYPE NARROWING, AND ITS RUNTIME CHECK IS SUBSUMED BY THE THIRD — do not
 * read it as independent coverage. `['asc', 'desc'].includes('sideways')` is already `false`, so
 * removing `isFeedbackSortDirection` changes no behaviour; it is here because `sort.direction` is
 * `unknown` and `readonly FeedbackSortDirection[]`'s `includes` will not take it. The clause that
 * carries the refusal is the third one.
 */
export const isFeedbackSortState = (sort: {
  column: unknown;
  direction: unknown;
}): sort is FeedbackSort =>
  isFeedbackSortColumn(sort.column) &&
  isFeedbackSortDirection(sort.direction) &&
  directionsFor(sort.column).includes(sort.direction);

/**
 * The columns whose CELL renders the NEGATION of the value the server orders by.
 *
 * 🔴 EXACTLY ONE, AND IT IS A CLAIM ABOUT THE SCREEN RATHER THAN ABOUT SQL. The Age cell is
 * `shortAge(createdAt)` — a DURATION, which grows as the row gets older, i.e. as its id shrinks. The
 * server orders by `f.id`, so `f.id ASC` is the OLDEST arrival first, which is the LARGEST duration
 * first, which reads as DESCENDING age. The arrow and `aria-sort` describe what is on screen, so
 * they flip here and nowhere else.
 *
 * 🔴 THIS USED TO BE AN `invert` FLAG ON THE SERVICE'S SQL MAP, AND MOVING IT IS THE POINT, NOT A
 * tidy-up. There it was consulted TWICE — by the `ORDER BY` and by the keyset's comparison operator
 * — so a flip applied to one and not the other produced an ordering the cursor walks backwards
 * through, every page turn re-serving rows the previous page already showed. Here the worst a wrong
 * flip can do is point a glyph the wrong way: it reaches no query and no cursor.
 */
const READS_INVERTED: readonly FeedbackSortColumn[] = ['age'];

/** How the active column's state READS on screen: the direction of the value its cell renders. */
const readsAscending = (sort: FeedbackSort): boolean =>
  READS_INVERTED.includes(sort.column) ? sort.direction === 'desc' : sort.direction === 'asc';

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

/**
 * `?sort=`/`?dir=` as a sort, or `null` for the default ordering.
 *
 * 🔴 AN ALLOWLIST MEMBERSHIP TEST, NEVER A PASS-THROUGH. Both params are typed on the URL by whoever
 * is holding the keyboard, and the column ends up naming a SQL identifier — so an unknown value has
 * to be refused here rather than reach the query builder. Neither layer ever interpolates the value
 * into SQL.
 *
 * 🔴 THIS LAYER DEGRADES; THE SERVICE THROWS, AND THAT ASYMMETRY IS DELIBERATE. Here the input is a
 * URL somebody typed, so a bad value must never 500 a queue nobody can then open — an unknown column
 * drops the whole sort (not just the column), and a direction the column does not offer falls back
 * to the FIRST state of that column's cycle, which is what a bare `?sort=area` from a hand-written
 * link should mean. The same `.catch()` contract every other param on this page has. At the service
 * layer the input is an ARGUMENT, so an unknown value is a programming error and degrading it would
 * return a page of real rows in an ordering nobody asked for, with no signal — see
 * `InvalidFeedbackSort` in `feedback.service.ts`.
 *
 * ⚠️ WHAT THIS FUNCTION EMITS MUST ALWAYS BE A STATE THE SERVICE ACCEPTS, or the asymmetry above
 * turns into a 500 on a hand-typed URL. That is why the fallback reads the column's own cycle rather
 * than a hardcoded `asc`: `age` does not offer `asc`'s counterpart, so `?sort=age&dir=desc` resolves
 * to `age`'s single state instead of passing `desc` through. Pinned as a relationship in
 * `feedback-sort.test.ts`.
 */
export function parseFeedbackSort(params: URLSearchParams): FeedbackSort | null {
  const column = params.get(FEEDBACK_SORT_PARAM);
  if (!isFeedbackSortColumn(column)) return null;
  const offered = directionsFor(column);
  const direction = params.get(FEEDBACK_SORT_DIR_PARAM);
  return {
    column,
    direction:
      isFeedbackSortDirection(direction) && offered.includes(direction) ? direction : offered[0],
  };
}

/**
 * The cycle: each of the column's own directions in turn, then none, then back to the first.
 *
 * For the five tri-state columns that is ascending → descending → none. For `age` it is a TWO-state
 * toggle — its one sorted state, then back to the default ordering — because its other state was
 * byte-identical to that default; `FEEDBACK_SORT_DIRECTIONS` carries the measurement.
 *
 * Clicking a DIFFERENT column always starts that column at ITS first state rather than inheriting
 * the direction of the one before it — the previous column's direction was a statement about a
 * different ordering, and carrying it over means the first click on a new column lands on a state
 * the operator did not choose. It would also be unrepresentable here: `desc` is not a state `age`
 * has.
 */
export function nextFeedbackSort(
  current: FeedbackSort | null,
  column: FeedbackSortColumn
): FeedbackSort | null {
  const offered = directionsFor(column);
  if (current?.column !== column) return { column, direction: offered[0] };
  // A direction this column does not offer can only come from a hand-edited URL the parser already
  // normalises; restarting the cycle is the visible answer if one ever reaches here.
  const at = offered.indexOf(current.direction);
  const next = at < 0 ? offered[0] : offered[at + 1];
  return next ? { column, direction: next } : null;
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
    /**
     * 🔴 A ONE-STATE COLUMN WRITES NO `?dir=` AT ALL, AND THAT IS THE HONEST SPELLING RATHER THAN A
     * saving. `age`'s single state is `asc` to the server (`f.id ASC`) and reads as DESCENDING on
     * screen, because the cell renders a duration — so writing the token would put `dir=asc` in the
     * URL under a `↓` header and an `aria-sort="descending"`. A direction param that contradicts the
     * screen is the defect this column already shipped once. Absence claims nothing, and the parser
     * resolves a bare `?sort=age` to that one state anyway.
     */
    [FEEDBACK_SORT_DIR_PARAM]:
      sort && directionsFor(sort.column).length > 1 ? sort.direction : null,
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
 *
 * 🔴 IT DESCRIBES THE RENDERED VALUE, NOT THE SQL. On `age` those run opposite (`READS_INVERTED`),
 * so its one sorted state — oldest report first — is announced as `descending`: a sighted operator
 * can see a contradiction between an arrow and the cells and self-correct, and a screen reader is
 * told one word with nothing to check it against.
 */
export function feedbackSortAria(
  current: FeedbackSort | null,
  column: FeedbackSortColumn
): 'ascending' | 'descending' | 'none' {
  if (current?.column !== column) return 'none';
  return readsAscending(current) ? 'ascending' : 'descending';
}

/**
 * The arrow next to an active header, and an empty string on every other column. Points the way the
 * CELLS run, which is why it reads `readsAscending` rather than the direction token.
 */
export function feedbackSortMarker(
  current: FeedbackSort | null,
  column: FeedbackSortColumn
): string {
  if (current?.column !== column) return '';
  return readsAscending(current) ? '↑' : '↓';
}
