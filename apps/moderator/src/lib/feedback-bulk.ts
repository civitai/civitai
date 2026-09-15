import {
  FEEDBACK_PAGE_SIZE,
  FEEDBACK_STATUSES,
  isFeedbackStatus,
  type FeedbackStatus,
} from './feedback';

/**
 * The bulk half of the triage queue: what the selection bar posts, and how it is read back.
 *
 * 🔴 EVERY PAIR CARRIES THE STATUS THE OPERATOR WAS LOOKING AT, not just an id. The single-row
 * action is scoped on `expectedStatus` so two moderators reaching opposite verdicts cannot produce
 * one silent overwrite (`triageFeedback`), and a bulk action that posted bare ids would be a hole
 * straight through that guard — the larger the selection, the more likely one row moved under it.
 * A selection spans rows at DIFFERENT statuses, so the expectation is per row and cannot be one
 * field on the form.
 */

/**
 * The most rows one submission may carry.
 *
 * Selection is cleared whenever `data.items` changes and the queue serves one keyset page at a
 * time, so one page IS the ceiling — there is no way to select past it.
 */
export const FEEDBACK_BULK_MAX = FEEDBACK_PAGE_SIZE;

/**
 * The tag the bulk action stamps on its refusals, read by the page to decide where they render.
 *
 * 🔴 A CONSTANT BECAUSE NOTHING CAN TEST THE SPELLING. The server writes it and the client branches
 * on it, and this app has no browser tier — so a typo on either side silently disables BOTH the
 * double-render guard and the orphaned-failure fallback, with every server-side test still passing
 * against its own literal.
 */
export const FEEDBACK_BULK_SCOPE = 'bulk';

export type FeedbackBulkRow = { id: number; expectedStatus: FeedbackStatus };

/** The wire form of one pair. Read by `parseFeedbackBulkRows`, which is the only consumer. */
const encodeRow = (row: FeedbackBulkRow) => `${row.id}:${row.expectedStatus}`;

export const encodeFeedbackBulkRows = (rows: readonly FeedbackBulkRow[]): string =>
  rows.map(encodeRow).join(',');

/** `Feedback.id` is a Postgres `integer`: a larger value ERRORS the comparison rather than missing. */
const MAX_INT4 = 2147483647;
const INTEGER = /^\d+$/;

/**
 * The hidden input, back into pairs — or a sentence explaining the refusal.
 *
 * 🔴 IT REFUSES, IT NEVER DROPS. `parseIdList` filters malformed entries out and truncates past its
 * limit, which on a destructive action means the screen reports a count it did not act on — the
 * defect `parseIdListStrict` exists to avoid. Here it is worse than a wrong count: a dropped pair is
 * a report the operator selected, watched the bar count, and which silently kept its old status. So
 * anything this cannot read in full is a refusal for the whole submission.
 *
 * A duplicate id is refused for the same reason rather than deduplicated: two pairs naming one row
 * carry two DIFFERENT expectations, and there is no basis for picking one. It cannot arise from the
 * selection bar — `SelectionSet` is a set — so it means the payload was edited.
 */
export function parseFeedbackBulkRows(
  raw: string,
  max: number = FEEDBACK_BULK_MAX
): FeedbackBulkRow[] | string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Select at least one report.';

  const parts = trimmed.split(',');
  if (parts.length > max)
    return `${parts.length} reports exceeds the limit of ${max} per action. Select fewer.`;

  const rows: FeedbackBulkRow[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    // Split on the FIRST colon only in spirit — a status never contains one, so an extra colon is
    // malformed input rather than a value to salvage.
    const [rawId, rawStatus, ...rest] = part.split(':');
    if (rest.length) return 'That selection could not be read. Reload and try again.';
    if (!rawId || !INTEGER.test(rawId))
      return 'That selection could not be read. Reload and try again.';

    const id = Number(rawId);
    if (id <= 0 || id > MAX_INT4) return 'That selection could not be read. Reload and try again.';
    if (!rawStatus || !isFeedbackStatus(rawStatus))
      return 'That selection could not be read. Reload and try again.';
    if (seen.has(id)) return 'That selection named one report twice. Reload and try again.';

    seen.add(id);
    rows.push({ id, expectedStatus: rawStatus });
  }
  return rows;
}

/**
 * The four bulk verdicts, in the order the bar shows them.
 *
 * 🔴 DERIVED FROM `FEEDBACK_STATUSES`, never a second hand-written list — a status added to the
 * CHECK constraint and to that constant but not here is a verdict the queue can hold and the bar
 * cannot set, which is invisible until someone looks for the missing button. The labels are the
 * only thing spelled out, because a button reading "new" is an instruction to nobody.
 */
const BULK_ACTION_LABELS: Record<FeedbackStatus, string> = {
  new: 'Reopen',
  reviewed: 'Mark reviewed',
  actioned: 'Mark actioned',
  dismissed: 'Dismiss',
};

export const FEEDBACK_BULK_ACTIONS: ReadonlyArray<{ status: FeedbackStatus; label: string }> =
  FEEDBACK_STATUSES.map((status) => ({ status, label: BULK_ACTION_LABELS[status] }));

const reports = (n: number) => `${n} report${n === 1 ? '' : 's'}`;

/**
 * WHICH surface renders an action failure. It NAMES one; whether only one acts on the answer is
 * the callers' business, and the paragraphs below are exact about how much of that is enforced.
 *
 * 🔴 THIS IS A FUNCTION RATHER THAN THREE `$derived` CONDITIONS BECAUSE THE DEFECT CLASS IS
 * DOUBLE-RENDERING, AND SEPARATE PREDICATES REGENERATED IT TWICE. First a scope test let a bulk 403
 * render in the bar AND at page level (`requiresGrant` stamps `denied`, not `bulk`); the fix swapped
 * that clause for a position test and re-opened the same defect one state over, because the two
 * remaining predicates were no longer mutually exclusive. Neither was visible to any test — this app
 * has no browser tier, so a page-level condition is verified by reading it.
 *
 * Returning ONE value removes the AMBIGUITY, and it is worth being exact about what that does and
 * does not buy. 🔴 THIS FUNCTION CANNOT ENFORCE THE EXCLUSION — that is the CALLERS' doing, and an
 * earlier version of this paragraph claimed otherwise. No test crosses the boundary into
 * `+page.svelte`, so a loosened comparison there ships green.
 *
 * 🔴 WHAT IS STRUCTURAL IS NARROWER THAN IT SOUNDS, AND THE SCOPE IS THE WHOLE POINT. The three
 * PAGE-LEVEL branches — `pageError`, the orphan alert, the filter hint — are arms of a single
 * `{#if}` chain in `+page.svelte`, so at most one of THOSE renders however they are spelled.
 *
 * 🔴 THE TWO SURFACES IN BOTH HISTORICAL INSTANCES OF THIS DEFECT ARE NOT IN THAT CHAIN.
 * `FeedbackBulkBar` and `FeedbackDetail` each render their own `FormState` error, so exclusion
 * against them rests ENTIRELY on the page comparing this answer against `'page'` and `'orphan'`
 * EXACTLY. Measured in the shipped tree: widening the orphan consumer to
 * `!== 'page' && !== 'none'` re-opens the 403 double-render — the bar and the page showing one
 * sentence twice — with the whole suite green and `svelte-check` clean. Keep both comparisons exact.
 *
 * ⚠️ An earlier draft of that example named `=== 'page'` → `!== 'bar'`, measured before the `{#if}`
 * chain existed. The chain masks that one now, which is exactly why the example is restated against
 * the current tree rather than carried forward.
 *
 * ⚠️ `bar` has NO consumer. The bar renders its own refusal from its component-local `FormState`
 * (`FeedbackBulkBar.svelte`), so that arm exists to DENY the page a refusal the bar is showing, not
 * to tell anything to render. Deleting it as unused re-opens the 403 double-render.
 *
 *   `bar`    — the selection bar is mounted, so it owns its own failure whatever `fail()` site
 *              produced it. This is the clause the scope test got wrong.
 *   `orphan` — a BULK refusal with the bar gone (the selection cleared mid-flight, or the operator
 *              unticked the last row). Its `FormState` died with the component; nothing else would
 *              show it.
 *   `page`   — everything else with no row open: the no-JS single-row surface.
 *   `none`   — no error, or a non-bulk refusal with a row open, which the detail panel renders from
 *              its own `FormState`.
 *
 * ⚠️ ONE GAP REMAINS AND IS DELIBERATE: a bulk refusal with the bar gone AND a row open resolves to
 * `orphan`, which the page renders above the table — not beside the panel the operator is looking
 * at. Visible, not silent; closing it properly needs the denial to carry an attributable scope.
 */
export function feedbackRefusalTarget(input: {
  hasError: boolean;
  barMounted: boolean;
  isBulkFailure: boolean;
  rowOpen: boolean;
}): 'bar' | 'orphan' | 'page' | 'none' {
  if (!input.hasError) return 'none';
  if (input.barMounted) return 'bar';
  if (input.isBulkFailure) return 'orphan';
  return input.rowOpen ? 'none' : 'page';
}

/**
 * What the operator is told after a bulk run that changed SOMETHING.
 *
 * 🔴 PARTIAL IS THE ORDINARY OUTCOME AND IT MUST BE SAID OUT LOUD, IN THREE PARTS THAT MEAN
 * DIFFERENT THINGS:
 *   - `changed`   — rows this action moved.
 *   - `actionable − changed` — rows whose UPDATE matched nothing. 🔴 THE CAUSE IS NOT KNOWN AND MUST
 *     NOT BE ASSERTED: `bulkTriageFeedback` deliberately does not spend a read per refusal, so a row
 *     someone else triaged and a row that was DELETED are indistinguishable here. Naming the first
 *     sends the operator looking for a colleague's verdict on a report that no longer exists.
 *   - `skipped`   — rows whose ON-SCREEN status already equalled the target. 🔴 A CLAIM ABOUT THE
 *     SCREEN, NOT THE DATABASE: it is derived from the posted expectations and nothing reads the
 *     rows back, so a stale page makes "already X" false of the database while staying true of what
 *     the operator was looking at. Worded accordingly. Silently dropping them is how "I selected
 *     10" becomes "Set 6" with nothing accounting for the other four.
 *
 * 🔴 THE VERDICT IS NAMED. The bar's buttons are the only other thing that says which verdict was
 * applied, and the bar unmounts the moment a successful run clears the selection — so a message that
 * omitted it would leave nothing on screen saying what just happened to fifty rows.
 *
 * No "reload to see the current verdicts": the bar's `FormState` runs with `reload: true`, so `load`
 * has already re-run by the time this renders.
 *
 * Zero changed with something actionable never reaches here — that is a refusal, raised as a
 * `fail()` by the action.
 */
export function feedbackBulkOutcome(input: {
  status: FeedbackStatus;
  changed: number;
  actionable: number;
  skipped: number;
}): string {
  const parts = [`Set ${reports(input.changed)} to ${input.status}.`];

  const refused = input.actionable - input.changed;
  if (refused > 0) {
    parts.push(
      `${reports(refused)} did not change — triaged elsewhere, or no longer in the queue.`
    );
  }
  if (input.skipped > 0) {
    // The verb agrees with THIS count, not with `changed`.
    parts.push(
      `${reports(input.skipped)} ${input.skipped === 1 ? 'was' : 'were'} already showing ${
        input.status
      }.`
    );
  }
  return parts.join(' ');
}
