import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseQuery, userIdSchema } from '$lib/server/query';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { ReportEntity, ReportStatus, reportReasons } from '$lib/reports';
import { getReportHistory, getReports, setReportStatus } from '$lib/server/reports.service';
import {
  addUserStrike,
  getUserStrikes,
  sendModNotification,
} from '$lib/server/moderation-memory.service';
import { getSuspectImages } from '$lib/server/report-triage.service';

// `user` opens the drill-down for one suspect, in the URL so a moderator can hand a colleague the exact
// queue position they are looking at.
const querySchema = z.object({
  user: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  page: z.coerce.number().int().positive().max(10_000).catch(1),
});

const PER_PAGE = 50;

// Retool excluded `reason = 'Automated'`: those are system-generated and drown the human queue.
const QUEUE_REASONS = reportReasons.filter((r) => r !== 'Automated');

export const load: PageServerLoad = async ({ url, locals }) => {
  const { user, page } = parseQuery(url, querySchema);
  // Reaching the queue is an investigation permission; acting on a report or an account is not.
  const canAct = canAccess(locals.user, '/users');

  const [reports, history, suspect, strikes] = await Promise.all([
    // The SAME query `/reports/user` runs. A parallel one diverged from the sidebar's counts on which
    // reasons it excluded, so the badge and this heading disagreed about one queue.
    getReports({
      type: ReportEntity.User,
      page,
      limit: PER_PAGE,
      statuses: [ReportStatus.Pending, ReportStatus.Processing],
      reasons: QUEUE_REASONS,
    }),
    getReportHistory(ReportEntity.User),
    user ? getSuspectImages(user) : null,
    user ? getUserStrikes(user) : null,
  ]);

  // The report row carries the suspect's id but not their state; hydrate through the shared helper
  // rather than joining User again — four hand-rolled copies of that join had already drifted.
  const suspectIds = [
    ...reports.items.map((r) => r.entityId ?? 0),
    ...history.items.map((h) => h.entityId ?? 0),
  ];
  const suspects = await usersByIds(suspectIds);

  return {
    queue: reports.items.map((r) => ({ ...r, suspect: suspects.get(r.entityId ?? 0) ?? null })),
    queueTotal: reports.totalItems,
    page: reports.page,
    perPage: reports.limit,
    history: history.items.map((h) => ({ ...h, suspect: suspects.get(h.entityId ?? 0) ?? null })),
    historyTruncated: history.truncated,
    suspectId: user ?? null,
    suspect,
    strikes,
    canAct,
  };
};

type Scope = 'report' | 'strike' | 'notify';
const scopedFail = (scope: Scope, message: string) => fail(400, { scope, error: message });

export const actions: Actions = {
  // Retool's ActionReport. `setReportStatus` also rewards the reporters when a report is Actioned and
  // refuses to double-reward, which Retool's raw REST call did not.
  actionReport: async ({ request, locals, getClientAddress }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('report', 'Not permitted.');
    const input = parseForm(
      z.object({
        id: z.coerce.number().int().positive().max(MAX_INT4),
        status: z.enum([ReportStatus.Actioned, ReportStatus.Unactioned, ReportStatus.Processing]),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('report', input);

    const result = await setReportStatus({
      id: input.id,
      status: input.status,
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    // Without this a stale tab acting on a since-deleted report gets the green path AND a ModActivity
    // `review` row for a report nobody touched.
    if (!result.ok) return scopedFail('report', result.error);
    return { success: true };
  },

  // Retool's InsertStrike + LogStrike + InsertStrikeNotif, which the shared service already does as one.
  strike: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('strike', 'Not permitted.');
    const author = locals.user.username;
    if (!author) return scopedFail('strike', 'Your account has no username to attribute it to.');

    const input = parseForm(
      userIdSchema.extend({ reason: z.string().trim().min(1).max(1000) }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('strike', input);

    const result = await addUserStrike({
      userId: input.userId,
      reason: input.reason,
      author,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return scopedFail('strike', result.error);

    // The strike LANDED. Returning a failure here would leave the form armed with its text intact and
    // the queue unrefreshed — the obvious next click issues a second strike. It is a success carrying
    // a warning, not a failure.
    return {
      success: true,
      warning: result.notified ? undefined : 'Strike recorded, but the user could not be notified.',
    };
  },

  // Retool's SendNotification2 / PostNotification / SendCorrectNotif — three call sites, one action.
  notify: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('notify', 'Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ message: z.string().trim().min(1).max(1000) }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('notify', input);

    const result = await sendModNotification({
      userId: input.userId,
      message: input.message,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return scopedFail('notify', result.error);
    return { success: true };
  },
};
