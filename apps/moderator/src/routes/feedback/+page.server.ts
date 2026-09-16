import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/public';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import { MAX_INT4, isInt4Id } from '$lib/server/users.service';
import {
  DEFAULT_FEEDBACK_STATUSES,
  FEEDBACK_STATUSES,
  feedbackAreaOptions,
  isFeedbackStatus,
} from '$lib/feedback';
import { FEEDBACK_CURSOR_VALUE_PARAM, parseFeedbackSort } from '$lib/feedback-sort';
import {
  FEEDBACK_BULK_MAX,
  FEEDBACK_BULK_SCOPE,
  feedbackBulkOutcome,
  parseFeedbackBulkRows,
} from '$lib/feedback-bulk';
import {
  FEEDBACK_PAGE_SIZE,
  bulkTriageFeedback,
  getFeedbackAreas,
  getFeedbackList,
  getKnownIssues,
  getSiblingFeedback,
  isMissingTriageColumns,
  linkFeedbackToBug,
  promoteFeedbackToBug,
  triageFeedback,
} from '$lib/server/feedback.service';

// Give every field a `.catch()`: query params are user-controllable, so a bad value degrades to the
// default rather than 500ing a queue nobody can then open. The int4 bound matters — a larger value
// ERRORS the comparison in Postgres rather than missing.
const querySchema = z.object({
  status: z.array(z.string()).catch([]),
  area: z.string().trim().catch(''),
  cursor: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  open: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  /**
   * The compound keyset's value half. Bounded in LENGTH only and never coerced here: which type it
   * has to be depends on which column `?sort=` names, and that mapping is the service's — see
   * `FEEDBACK_SORT_KEYS`. The bound exists because this reaches Postgres as a parameter and an
   * unbounded one is free work for whoever hand-edits the URL.
   */
  [FEEDBACK_CURSOR_VALUE_PARAM]: z.string().max(300).optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, request, locals }) => {
  // `cursorValue` is destructured by its literal name on purpose: the schema key above is the
  // CONSTANT, so renaming the param breaks this line at compile time rather than silently reading a
  // field nothing writes.
  const { status, area, cursor, open, cursorValue } = parseQuery(url, querySchema, ['status']);
  // Both params are typed by whoever is holding the keyboard. `parseFeedbackSort` is an allowlist
  // membership test, so an unknown column degrades to the default ordering rather than reaching the
  // query builder.
  //
  // 🔴 THE SERVICE REFUSES A SECOND TIME AND THROWS RATHER THAN DEGRADING, so this line is also the
  // thing that keeps a hand-typed `?sort=` off the error boundary: everything the parser emits is a
  // state `getFeedbackList` accepts. Do not "simplify" this to reading the params directly.
  const sort = parseFeedbackSort(url.searchParams);
  /**
   * 🔴 PRESENT-BUT-REJECTED IS NOT ABSENT, AND THE TWO ARE OPPOSITE INSTRUCTIONS. `.catch(undefined)`
   * collapses a param the schema refused into the same value as one that was never sent — and the
   * service reads an absent value half as "the boundary row's value IS null", a real position in the
   * ordering. So an over-long `?cursorValue=` would not degrade, it would silently relocate the
   * operator into the trailing null block. Nothing else on this page has this problem: every other
   * param's rejected value and its absent value mean the same thing.
   *
   * The whole cursor goes, not just the half — the service's own contract, for the same reason.
   */
  const cursorValueRejected =
    url.searchParams.has(FEEDBACK_CURSOR_VALUE_PARAM) && cursorValue === undefined;
  // A present-but-empty `?status=` is a deliberate "all"; an ABSENT one is the default view.
  const statuses = url.searchParams.has('status')
    ? status.filter(isFeedbackStatus)
    : DEFAULT_FEEDBACK_STATUSES;

  // Canonicalise a bare landing so the active default is explicit and shareable.
  //
  // 🔴 GET only. A form action posts to `?/triage`, which replaces the whole query string, so on a
  // POST this condition is true — and a 307 PRESERVES THE METHOD, so a no-JS client would re-POST
  // and run the action a second time, tripping its own concurrency guard and reporting a spurious
  // conflict over a save that worked. Enhanced submits never reach `load`, so the JS path never saw
  // it. The defaults above apply either way, so skipping the redirect changes nothing on screen.
  if (request.method === 'GET' && !url.searchParams.has('status')) {
    const canonical = new URL(url);
    DEFAULT_FEEDBACK_STATUSES.forEach((s) => canonical.searchParams.append('status', s));
    redirect(307, canonical.pathname + canonical.search);
  }

  /**
   * 🔴 The migration is applied BY HAND, per environment, and this page reaches production before
   * anyone runs it. `moderator:admin` short-circuits every page grant, so the sidebar entry and its
   * badge are live on the day this deploys — and the badge counts on `status` alone, so it renders
   * a real number against an unmigrated database. The click is what breaks: the list selects four
   * columns that do not exist yet.
   *
   * Degraded rather than thrown. An uncaught 42703 out of `load` is the error boundary plus an
   * Axiom entry per click, and it tells the operator nothing about what to do.
   */
  let list: Awaited<ReturnType<typeof getFeedbackList>>;
  let areas: string[];
  try {
    [list, areas] = await Promise.all([
      getFeedbackList({
        statuses,
        area: area || null,
        cursor: cursorValueRejected ? null : cursor ?? null,
        cursorValue: cursorValue ?? null,
        sort,
        limit: FEEDBACK_PAGE_SIZE,
      }),
      getFeedbackAreas(),
    ]);
  } catch (e) {
    if (!isMissingTriageColumns(e)) throw e;
    return {
      items: [],
      nextCursor: null,
      nextCursorValue: null,
      sort,
      statuses,
      area,
      open: null,
      openVisible: false,
      siblings: [],
      knownIssues: [],
      areaOptions: [],
      grafanaUrl: null,
      migrationPending: true as const,
    };
  }

  // Only for the row that is actually open — this is the one read on the page that is not needed to
  // render the list.
  const openRow = open ? list.items.find((r) => r.id === open) : undefined;
  const siblings =
    openRow?.bugId != null
      ? await getSiblingFeedback({ bugId: openRow.bugId, excludeId: openRow.id })
      : [];

  /**
   * The issue picker's options, on exactly the condition that renders the picker.
   *
   * Follows `siblings` above rather than loading with the list: an UNLINKED open row is the only
   * state `FeedbackPromote`'s attach form exists in, so loading these for a queue view with nothing
   * open is a query per page turn for a control nobody can see. The grant is part of the condition
   * for the same reason — the form is not rendered without it.
   */
  const knownIssues =
    openRow && openRow.bugId === null && locals.grants['feedback.bug.promote']
      ? await getKnownIssues()
      : [];

  return {
    migrationPending: false as const,
    items: list.items,
    nextCursor: list.nextCursor,
    nextCursorValue: list.nextCursorValue,
    sort,
    statuses,
    area,
    open: open ?? null,
    // A shared `?open=` can name a row the current filters exclude. Said out loud rather than
    // rendering nothing, which is indistinguishable from no row being open at all.
    openVisible: !!openRow,
    siblings,
    knownIssues,
    areaOptions: feedbackAreaOptions(areas),
    /**
     * 🔴 NULL when unset, and the panel renders no link at all in that case. A missing base would
     * otherwise build `undefined/explore`, which looks live and is not. The origin is deliberately
     * absent from this repo — see `.env.example`.
     */
    grafanaUrl: env.PUBLIC_GRAFANA_URL?.trim() || null,
  };
};

const statusEnum = z.enum(FEEDBACK_STATUSES);

const triageSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_INT4),
  status: statusEnum,
  // The status the operator was LOOKING AT. Posted by the form, never re-read from the database —
  // re-reading it here would make the guard agree with itself.
  expectedStatus: statusEnum,
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
});

// Page access is gated centrally in `hooks.server.ts` against `/feedback`; these two guard the
// WRITES, which is the independent axis.
export const actions: Actions = {
  triage: requiresGrant('feedback.status.set', async ({ request, locals }) => {
    const input = parseForm(triageSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const result = await triageFeedback({
      id: input.id,
      status: input.status,
      expectedStatus: input.expectedStatus,
      // Trimmed, and empty becomes NULL rather than an empty string — the column means "no note".
      note: input.note?.trim() || null,
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
  }),

  /**
   * The selection bar. Behind the SAME grant as the single-row triage, deliberately: it is the same
   * verdict, and a separate permission would be a second answer to "may this person set a status"
   * that nobody would remember to keep aligned. What it is NOT gated on is the row count — a
   * moderator who may triage one report may triage fifty of them.
   */
  bulkTriage: requiresGrant('feedback.status.set', async ({ request, locals }) => {
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
  }),

  promote: requiresGrant('feedback.bug.promote', async ({ request, locals }) => {
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

    const promoted = await promoteFeedbackToBug({
      id: input.id,
      title,
      summary,
      moderatorId: locals.user.id,
    });
    return promoted.ok ? { success: true, bugId: promoted.bugId } : promoteFailure(promoted.reason);
  }),
};

const promoteFailure = (reason: 'already-linked' | 'no-such-bug' | 'gone') => {
  if (reason === 'no-such-bug') return fail(404, { error: 'No issue with that number.' });
  if (reason === 'gone') return fail(410, { error: 'That feedback no longer exists.', gone: true });
  return fail(409, { error: 'That feedback is already linked to an issue. Reload to see which.' });
};
