// Cursor and numbered paging both live in the URL, and anything invalidating a batch must clear
// BOTH (`clearPaging`) — a stale param from the other scheme reopens a page of a dead query.
// The cursor trail holds one entry per page past the first and its last entry is always the
// current `cursor`, so page number is `trail.length + 1` and Back is a pop.

const TRAIL_PARAM = 'cursors';

/** Distinct from the queue's own `page`: on User Reports both are live at once. */
export const IMAGE_PAGE_PARAM = 'imgPage';

/**
 * The second half of a COMPOUND keyset — the boundary row's value in the sorted column, where
 * `cursor` carries its id. Only `/feedback` writes it today (`$lib/feedback-sort.ts`).
 *
 * 🔴 IT LIVES HERE, WITH THE OTHER PAGING PARAMS, RATHER THAN IN THE PAGE THAT INVENTED IT. A page
 * that owned its own clearing rule would be a SECOND door onto the one below: ten files in this app
 * reach for `clearPaging` (measured — `grep -rl clearPaging src/`, excluding this file and the
 * tests), and the next control added to a compound-cursor page reaches for it too. Then the value
 * half survives a batch change — and it is the OPERAND of the keyset comparison, so the "first" page
 * of the new query starts somewhere in the middle of the old ordering. Under one page of rows that
 * is invisible, so it is not caught by looking. Deleting a param a page never sets costs nothing; a
 * rule with two doors costs a wrong page.
 *
 * That was not hypothetical: `FeedbackPromote.svelte`'s `siblingHref` was already a third door,
 * dropping `?cursor=` through this helper and leaving `?cursorValue=` orphaned behind it.
 */
export const CURSOR_VALUE_PARAM = 'cursorValue';

export function readCursorTrail(params: URLSearchParams): string[] {
  return params.get(TRAIL_PARAM)?.split(',').filter(Boolean) ?? [];
}

export function writeCursorTrail(params: URLSearchParams, trail: string[]) {
  if (trail.length) {
    params.set(TRAIL_PARAM, trail.join(','));
    params.set('cursor', trail[trail.length - 1]);
  } else {
    clearPaging(params);
  }
}

/** Call whenever the batch changes, or the moderator lands on page 7 of a three-page result. */
export function clearPaging(params: URLSearchParams) {
  params.delete('cursor');
  params.delete(CURSOR_VALUE_PARAM);
  params.delete(TRAIL_PARAM);
  params.delete(IMAGE_PAGE_PARAM);
}

/** Query string minus paging — a batch key that survives page turns. */
export function nonPagingSearch(search: string): string {
  const params = new URLSearchParams(search);
  clearPaging(params);
  return params.toString();
}
