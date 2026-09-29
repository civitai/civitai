import { urlWith } from './url';

/** The param that names the open row. Spelled once here because the queue and its tests both write it. */
export const FEEDBACK_OPEN_PARAM = 'open';

/**
 * The `href` that OPENS a report's panel in the queue (or closes it, with `id === null`).
 *
 * Everything else on the URL survives: the filters and `?cursor=` describe the QUEUE, which is the
 * same queue before and after.
 *
 * ⚠️ IT NO LONGER DELETES `?tab=`, BECAUSE THERE ARE NO TABS. That deletion was the reason this
 * function was extracted: the panel used to be a tab strip whose selection lived in the query string
 * beside the queue's own filters, so it outlived the row it was chosen for — opening row B after
 * triaging row A on the Triage tab rendered row B's panel as four status buttons and none of its
 * report text. The sections are stacked now, so no per-row state rides the URL and there is nothing
 * to clear. Re-adding a panel selector to the query string brings the bug back with it.
 *
 * 🔴 THE PARAM ONLY RESOLVES AGAINST THE CURRENT VIEW. A row the active filters or the current
 * keyset page exclude is not in `data.items`, so `?open=` names it and the queue cannot show it —
 * `/feedback/<id>` is the link that always resolves, and is what anything outside this queue should
 * point at.
 */
export function feedbackOpenHref(url: URL, id: number | null): string {
  return urlWith(url, { [FEEDBACK_OPEN_PARAM]: id });
}

/** The permanent link to one report, independent of the queue's filters, sort and cursor. */
export const feedbackReportHref = (id: number): string => `/feedback/${id}`;
