import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/public';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  DEFAULT_FEEDBACK_STATUSES,
  FEEDBACK_STATUSES,
  feedbackAreaOptions,
  isFeedbackStatus,
} from '$lib/feedback';
import {
  FEEDBACK_PAGE_SIZE,
  decodeFeedbackCursor,
  getFeedbackAreas,
  getFeedbackList,
  getSiblingFeedback,
  linkFeedbackToBug,
  promoteFeedbackToBug,
  triageFeedback,
} from '$lib/server/feedback.service';

const MAX_INT4 = 2_147_483_647;

// Give every field a `.catch()`: query params are user-controllable, so a bad value degrades to the
// default rather than 500ing a queue nobody can then open.
const querySchema = z.object({
  status: z.array(z.string()).catch([]),
  area: z.string().trim().catch(''),
  cursor: z.string().trim().catch(''),
  open: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  // Canonicalise a bare landing so the active default is explicit and shareable. Only an ABSENT
  // `status` gets the default — a present-but-empty `?status=` is a deliberate "all", left alone.
  if (!url.searchParams.has('status')) {
    const canonical = new URL(url);
    DEFAULT_FEEDBACK_STATUSES.forEach((s) => canonical.searchParams.append('status', s));
    redirect(307, canonical.pathname + canonical.search);
  }

  const { status, area, cursor, open } = parseQuery(url, querySchema, ['status']);
  const statuses = status.filter(isFeedbackStatus);

  const [list, areas] = await Promise.all([
    getFeedbackList({
      statuses,
      area: area || null,
      cursor: decodeFeedbackCursor(cursor),
      limit: FEEDBACK_PAGE_SIZE,
    }),
    getFeedbackAreas(),
  ]);

  // Only for the row that is actually open — this is the one read on the page that is not needed to
  // render the list.
  const openRow = open ? list.items.find((r) => r.id === open) : undefined;
  const siblings =
    openRow?.bugId != null
      ? await getSiblingFeedback({ bugId: openRow.bugId, excludeId: openRow.id })
      : [];

  return {
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
  // `''` for the new-bug path; a numeric string attaches to an existing Bug instead.
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

    if (!result.ok)
      return fail(410, { error: 'That feedback no longer exists.', gone: true });
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

    const existingBugId = input.bugId ? Number(input.bugId) : null;
    if (existingBugId !== null) {
      if (!Number.isInteger(existingBugId) || existingBugId <= 0 || existingBugId > MAX_INT4)
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
    if (!summary) return fail(400, { error: 'Write a summary — it is what the issue board shows.' });

    const promoted = await promoteFeedbackToBug({
      id: input.id,
      title,
      summary,
      moderatorId: locals.user.id,
    });
    return promoted.ok ? { success: true, bugId: promoted.bugId } : promoteFailure(promoted.reason);
  }),
};

const promoteFailure = (reason: 'already-linked' | 'no-such-bug') =>
  reason === 'no-such-bug'
    ? fail(404, { error: 'No issue with that number.' })
    : fail(409, {
        error: 'That feedback is already linked to an issue. Reload to see which.',
      });
