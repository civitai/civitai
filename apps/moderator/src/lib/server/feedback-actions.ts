import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { isClickupTaskUrl } from '@civitai/shared/clickup-url';
import { requiresGrant } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import { MAX_INT4, isInt4Id } from '$lib/server/users.service';
import { FEEDBACK_STATUSES } from '$lib/feedback';
import {
  FEEDBACK_BULK_MAX,
  FEEDBACK_BULK_SCOPE,
  feedbackBulkOutcome,
  parseFeedbackBulkRows,
} from '$lib/feedback-bulk';
import {
  bulkTriageFeedback,
  linkFeedbackToBug,
  promoteFeedbackToBug,
  triageFeedback,
} from '$lib/server/feedback.service';

/**
 * The feedback queue's writes, owned here rather than by one route.
 *
 * 🔴 TWO ROUTES POST TO THESE — `/feedback` (the queue, whose panel expands in place) and
 * `/feedback/<id>` (the permanent link to one report) — and a form action is resolved against the
 * route the FORM is on, so the same handler has to be registered under both. Copying them would be
 * two definitions of the concurrency guard, the ClickUp gate and the refusal wording, and the copy
 * that drifts is the one nobody is looking at.
 *
 * Page access is gated centrally in `hooks.server.ts` against `/feedback`, which `canAccess`
 * resolves by prefix for `/feedback/<id>` too. `requiresGrant` below guards the WRITES, which is the
 * independent axis.
 */

const statusEnum = z.enum(FEEDBACK_STATUSES);

const triageSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_INT4),
  status: statusEnum,
  // The status the operator was LOOKING AT. Posted by the form, never re-read from the database —
  // re-reading it here would make the guard agree with itself.
  expectedStatus: statusEnum,
  /**
   * 🔴 OPTIONAL, AND AN ABSENT `note` IS NOT AN EMPTY ONE. The panel posts this field only when it
   * carries a box for it; the status buttons post `id`, `expectedStatus` and `status` alone. Reading
   * an absent field as `''` and storing `null` would wipe the stored note on every status click — a
   * write nothing reports and nothing in this app can undo. `undefined` is forwarded as `undefined`
   * and `triageFeedback` leaves the column out of its `SET`.
   */
  note: z.string().max(5000).optional(),
});

const bulkTriageSchema = z.object({
  status: statusEnum,
  /**
   * The `id:status` pairs the selection bar posts. Bounded in LENGTH here and parsed for SHAPE by
   * `parseFeedbackBulkRows`, which enforces the row count — the two bounds are not redundant: this
   * one keeps an unbounded string off the parser at all, and 50 pairs cannot reach 4 KB.
   */
  rows: z.string().max(4000),
});

const promoteSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_INT4),
  // 🔴 POSTED EXPLICITLY, never inferred from whether `bugId` is blank. Inferring it sends an empty
  // issue-number box down the create-a-new-issue branch, which then refuses with "Give the issue a
  // title" over a form showing no title field.
  mode: z.enum(['create', 'attach']),
  bugId: z.string().trim().optional(),
  title: z.string().trim().max(300).optional(),
  summary: z.string().trim().max(5000).optional(),
  /**
   * The ClickUp task this issue tracks. Optional, and only read on the `create` branch — attaching
   * to an existing issue must not silently re-link the issue someone else already linked.
   *
   * Bounded here for the same reason every other box is: to keep an unbounded string off the
   * parser. 2000 is far above any real ClickUp URL and far below a payload worth worrying about.
   */
  clickupUrl: z.string().trim().max(2000).optional(),
});

export const triageAction = requiresGrant(
  'feedback.status.set',
  async ({ request, locals }: RequestEvent) => {
    const input = parseForm(triageSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const result = await triageFeedback({
      id: input.id,
      status: input.status,
      expectedStatus: input.expectedStatus,
      /**
       * 🔴 THE THREE-WAY DISTINCTION THE COLUMN NEEDS, and the middle case is the one that bites.
       * Field absent → `undefined` → the column is not written. Field present and blank → `null`,
       * because the column means "no note" rather than "an empty note". Field present with text →
       * trimmed text.
       */
      note: input.note === undefined ? undefined : input.note.trim() || null,
      moderatorId: locals.user.id,
    });

    if (!result.ok) return fail(410, { error: 'That feedback no longer exists.', gone: true });
    // 🔴 Zero affected rows is a REFUSAL. The UPDATE is scoped on the status the operator was
    // looking at, so nothing moving means someone else's verdict is already on the row.
    if (!result.changed)
      return fail(409, {
        error: 'Someone else already triaged this. Reload to see the current verdict.',
      });

    return { success: true, triaged: input.id };
  }
);

/**
 * The selection bar. Behind the SAME grant as the single-row triage, deliberately: it is the same
 * verdict, and a separate permission would be a second answer to "may this person set a status"
 * that nobody would remember to keep aligned. What it is NOT gated on is the row count — a
 * moderator who may triage one report may triage fifty of them.
 *
 * Registered by the QUEUE only: there is no selection on a single-report page.
 */
export const bulkTriageAction = requiresGrant(
  'feedback.status.set',
  async ({ request, locals }: RequestEvent) => {
    const form = await request.formData();
    const input = parseForm(bulkTriageSchema, form);
    if (typeof input === 'string') return fail(400, { error: input, scope: FEEDBACK_BULK_SCOPE });

    // Refuses the whole submission rather than dropping what it cannot read — see its docstring.
    const rows = parseFeedbackBulkRows(input.rows, FEEDBACK_BULK_MAX);
    if (typeof rows === 'string') return fail(400, { error: rows, scope: FEEDBACK_BULK_SCOPE });

    const { changed, actionable } = await bulkTriageFeedback({
      rows,
      status: input.status,
      moderatorId: locals.user.id,
    });

    /**
     * 🔴 The two zero-change outcomes are different facts and get different words. Neither is a
     * success: reporting one would write a verdict on screen that no row carries.
     *
     * 🔴 THIS ONE CLAIMS THE SCREEN, NOT THE DATABASE, AND THE DISTINCTION IS NOT PEDANTRY.
     * `actionable` is derived entirely from the POSTED expectations — nothing is read back here — so
     * "is already X" would be an assertion about rows this request never looked at. Measured: a row
     * sitting at `new` in the database, posted as `reviewed` against a target of `reviewed`, returns
     * `actionable: 0` and is not touched; telling the operator it "is already reviewed" is false AND
     * is the sentence that stops them retrying. Saying what was on their screen is true by
     * construction and points at the real cause.
     */
    if (!actionable)
      return fail(409, {
        error: `Every selected report was already showing ${input.status}. Reload if you expected a change — the queue may have moved under this page.`,
        scope: FEEDBACK_BULK_SCOPE,
      });
    // 🔴 NO CAUSE IS ASSERTED. `bulkTriageFeedback` does not spend a read per refusal, so "someone
    // else triaged it" and "the row is gone" are indistinguishable here — and naming the first sends
    // the operator looking for a colleague's verdict on a report that no longer exists.
    if (!changed.length)
      return fail(409, {
        error:
          'None of the selected reports changed — they were triaged elsewhere, or are no longer in the queue.',
        scope: FEEDBACK_BULK_SCOPE,
      });

    return {
      success: true,
      bulkMessage: feedbackBulkOutcome({
        status: input.status,
        changed: changed.length,
        actionable,
        // Rows the service declined to touch because they were ALREADY at the target. Counted here
        // rather than returned, so the service keeps one definition of what it was asked to move.
        skipped: rows.length - actionable,
      }),
    };
  }
);

const promoteFailure = (reason: 'already-linked' | 'no-such-bug' | 'gone') => {
  if (reason === 'no-such-bug') return fail(404, { error: 'No issue with that number.' });
  if (reason === 'gone') return fail(410, { error: 'That feedback no longer exists.', gone: true });
  return fail(409, { error: 'That feedback is already linked to an issue. Reload to see which.' });
};

export const promoteAction = requiresGrant(
  'feedback.bug.promote',
  async ({ request, locals }: RequestEvent) => {
    const input = parseForm(promoteSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    if (input.mode === 'attach') {
      // Blank and malformed are different mistakes: telling someone who typed `abc` to "enter an
      // issue number" is an instruction they already followed.
      if (!input.bugId) return fail(400, { error: 'Enter an issue number.' });
      const existingBugId = Number(input.bugId);
      if (!isInt4Id(existingBugId))
        return fail(400, { error: 'That is not a valid issue number.' });

      const linked = await linkFeedbackToBug({
        id: input.id,
        bugId: existingBugId,
        moderatorId: locals.user.id,
      });
      return linked.ok ? { success: true, bugId: linked.bugId } : promoteFailure(linked.reason);
    }

    // A Bug title is a summary and a feedback message is a complaint, so the moderator writes both
    // rather than the form seeding them.
    const title = input.title ?? '';
    const summary = input.summary ?? '';
    if (!title) return fail(400, { error: 'Give the issue a title.' });
    if (!summary)
      return fail(400, { error: 'Write a summary — it is what the issue board shows.' });

    /**
     * 🔴 REFUSED, NOT STORED-AND-HOPED. The ClickUp webhook finds the entry to close by parsing a
     * task id back out of this column, so a URL that does not parse is a link in name only: the
     * issue board shows it, and the task completing closes nothing. That failure reports itself
     * NOWHERE — no error, no log, just an issue that stays open forever — so the only place it can
     * be caught is here, while the person who pasted it is still looking at the form.
     *
     * 🔴 `isClickupTaskUrl`, NOT `clickupTaskIdFromUrl`. The matcher is deliberately permissive
     * because it READS rows other tools wrote, and gating on it would have made this — the first
     * path that can write this column from the moderator queue — looser than the board's own create
     * form, which requires `z.url()`. A bare id and a foreign host both satisfy the matcher.
     *
     * ⚠️ This checks the URL's SHAPE and cannot check the webhook's SCOPE: the subscription covers
     * one ClickUp list, so a well-formed task URL from any other list stores fine and still never
     * auto-closes. The form copy says so; this guard must not be read as covering it.
     *
     * Blank stays blank: the box is optional, and both functions read '' as absent.
     */
    const clickupUrl = input.clickupUrl || '';
    if (clickupUrl && !isClickupTaskUrl(clickupUrl))
      return fail(400, {
        error:
          'That does not look like a ClickUp task link — paste the task URL from ClickUp, like https://app.clickup.com/t/868kfwm3j.',
      });

    const promoted = await promoteFeedbackToBug({
      id: input.id,
      title,
      summary,
      // Empty becomes NULL rather than an empty string — the column means "no task linked", the
      // same way the triage note's column means "no note". Both spellings read as unlinked to the
      // webhook (`contains <taskId>` cannot match ''), so this is about the column carrying one
      // representation of absent rather than about the matcher.
      clickupUrl: clickupUrl || null,
      moderatorId: locals.user.id,
    });
    return promoted.ok ? { success: true, bugId: promoted.bugId } : promoteFailure(promoted.reason);
  }
);
