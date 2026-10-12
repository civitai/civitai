import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import type { Actions, PageServerLoad } from './$types';
import { isInt4Id } from '$lib/server/users.service';
import { promoteAction, triageAction } from '$lib/server/feedback-actions';
import {
  feedbackPanelExtras,
  getFeedbackRow,
  isMissingTriageColumns,
} from '$lib/server/feedback.service';

/**
 * 🔴 `params.id` IS USER-CONTROLLABLE AND MUST NEVER 500. It is a path segment, so it reaches this
 * page as any string at all — and `Feedback.id` is an int4, where a comparison against an
 * out-of-range value ERRORS in Postgres rather than missing a row. Everything outside the column's
 * own domain is a 404 before any query runs.
 *
 * 🔴 THE SHAPE TEST COMES FIRST, BECAUSE `Number` IS LENIENT IN WAYS `Number.isInteger` CANNOT SEE
 * — the same trap `coerceSortValue` in `$lib/server/feedback.service.ts` carries its own `INTEGER`
 * regex for. `Number('0x10')` is 16, `Number('1e3')` is 1000 and `Number(' 12 ')` is 12, and all
 * three pass `Number.isInteger`: without this, `/feedback/0x10` quietly serves report 16, so one
 * report has unboundedly many URLs and none of them is the one anybody shared.
 *
 * `[1-9]` rather than `\d` on the first digit closes the leading-zero case (`/feedback/0000412`)
 * that the sentence above would otherwise over-claim about. The BOUND is `isInt4Id`, not a
 * hand-rolled comparison — the column is an int4 and that predicate is where this app says so.
 */
const parseFeedbackId = (raw: string): number | null => {
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return isInt4Id(id) ? id : null;
};

/**
 * One report, resolved with no reference to the queue's filters, sort or cursor.
 *
 * 🔴 THAT INDEPENDENCE IS THE ROUTE'S ENTIRE REASON TO EXIST. `/feedback?open=<id>` resolves the id
 * against the rows the CURRENT view holds, so a link to anything outside the active status filter or
 * past the first keyset page lands on the "Report #N is not in this view" notice. A link that leaves
 * this app cannot carry the view it was made in.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
  const id = parseFeedbackId(params.id);
  if (id === null) throw error(404, 'No such report.');

  let row: Awaited<ReturnType<typeof getFeedbackRow>>;
  try {
    row = await getFeedbackRow(id);
  } catch (e) {
    /**
     * The triage migration is applied BY HAND, per environment, so there is a real window where this
     * route is live against a database whose columns do not exist yet. The queue degrades to an
     * explanatory empty state because it still has a list to draw; this page has nothing to render
     * without the row, so it refuses and names the migration to run.
     */
    if (!isMissingTriageColumns(e)) throw e;
    throw error(
      503,
      'This queue is not ready yet — apply 20260911120000_feedback_triage to this database.'
    );
  }
  if (!row) throw error(404, 'No such report.');

  // The panel's prerequisites, from the one place that decides them — see `feedbackPanelExtras`.
  const { siblings, knownIssues } = await feedbackPanelExtras(row, locals.grants);

  return {
    row,
    siblings,
    knownIssues,
    // 🔴 NULL when unset, and the panel renders no link at all in that case. A missing base would
    // otherwise build `undefined/explore`, which looks live and is not.
    grafanaUrl: env.PUBLIC_GRAFANA_URL?.trim() || null,
  };
};

/**
 * The two writes the panel makes, shared with the queue — see `$lib/server/feedback-actions.ts`. A
 * form action resolves against the route the form is on, so both pages have to register them.
 *
 * `bulkTriage` is deliberately absent: there is no selection here.
 */
export const actions: Actions = {
  triage: triageAction,
  promote: promoteAction,
};
