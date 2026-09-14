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
import {
  FEEDBACK_PAGE_SIZE,
  getFeedbackAreas,
  getFeedbackList,
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
});

export const load: PageServerLoad = async ({ url, request }) => {
  const { status, area, cursor, open } = parseQuery(url, querySchema, ['status']);
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
        cursor: cursor ?? null,
        limit: FEEDBACK_PAGE_SIZE,
      }),
      getFeedbackAreas(),
    ]);
  } catch (e) {
    if (!isMissingTriageColumns(e)) throw e;
    return {
      items: [],
      nextCursor: null,
      statuses,
      area,
      open: null,
      openVisible: false,
      siblings: [],
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

  return {
    migrationPending: false as const,
    items: list.items,
    nextCursor: list.nextCursor,
    statuses,
    area,
    open: open ?? null,
    // A shared `?open=` can name a row the current filters exclude. Said out loud rather than
    // rendering nothing, which is indistinguishable from no row being open at all.
    openVisible: !!openRow,
    siblings,
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
