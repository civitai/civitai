// Cursor and numbered paging both live in the URL, and anything invalidating a batch must clear
// BOTH (`clearPaging`) — a stale param from the other scheme reopens a page of a dead query.
// The cursor trail holds one entry per page past the first and its last entry is always the
// current `cursor`, so page number is `trail.length + 1` and Back is a pop.

const TRAIL_PARAM = 'cursors';

/** Distinct from the queue's own `page`: on User Reports both are live at once. */
export const IMAGE_PAGE_PARAM = 'imgPage';

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
  params.delete(TRAIL_PARAM);
  params.delete(IMAGE_PAGE_PARAM);
}

/** Query string minus paging — a batch key that survives page turns. */
export function nonPagingSearch(search: string): string {
  const params = new URLSearchParams(search);
  clearPaging(params);
  return params.toString();
}
