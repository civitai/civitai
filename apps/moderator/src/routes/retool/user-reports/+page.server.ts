import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseIdList, parseQuery, userIdSchema } from '$lib/server/query';
import { removeImages, restoreImages, setImageFlag } from '$lib/server/user-actions.service';
import { VIOLATION_TYPES } from '$lib/violations';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { ReportEntity, ReportStatus, reportReasons } from '$lib/reports';
import { getReportHistory, getReports, setReportStatus } from '$lib/server/reports.service';
import {
  addUserStrike,
  getUserStrikes,
  sendModNotification,
} from '$lib/server/moderation-memory.service';
import { getSuspectImages } from '$lib/server/report-triage.service';
import { ingestionErrorLevelSet } from '@civitai/shared';

// `user` opens the drill-down for one suspect, in the URL so a moderator can hand a colleague the exact
// queue position they are looking at.
const boolParam = z
  .string()
  .optional()
  .transform((v) => v === '1');
const dateParam = z
  .string()
  .optional()
  .transform((v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  });

const querySchema = z.object({
  user: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  page: z.coerce.number().int().positive().max(10_000).catch(1),
  cursor: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  tos: boolParam,
  noPrompt: boolParam,
  // Absent means every rating, so an unticked box set and a fully ticked one read the same. 0 is
  // allowed on purpose: an unrated image has no browsing level, and without it ticking every box
  // silently drops exactly the images no scanner has judged yet.
  levels: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map(Number)
        .filter((n) => n === 0 || ingestionErrorLevelSet.has(n))
    ),
  from: dateParam,
  // Inclusive: a date-only `to` parses as that midnight, which would exclude the whole day picked.
  to: dateParam.transform((d) =>
    d ? new Date(d.getTime() + (d.getTime() % 86_400_000 === 0 ? 86_399_999 : 0)) : null
  ),
  prompt: z.string().trim().max(200).catch(''),
  negativePrompt: z.string().trim().max(200).catch(''),
});

const PER_PAGE = 50;

// Retool excluded `reason = 'Automated'`: those are system-generated and drown the human queue.
const QUEUE_REASONS = reportReasons.filter((r) => r !== 'Automated');

export const load: PageServerLoad = async ({ url, locals }) => {
  const { user, page, cursor, tos, noPrompt, levels, from, to, prompt, negativePrompt } =
    parseQuery(url, querySchema);
  const filters = { tosOnly: tos, noPrompt, levels, from, to, prompt, negativePrompt };
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
    user ? getSuspectImages(user, filters, { cursor }) : null,
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
    filters: {
      tos,
      noPrompt,
      levels,
      from: from ? from.toISOString().slice(0, 10) : '',
      to: to ? to.toISOString().slice(0, 10) : '',
      prompt,
      negativePrompt,
    },
    strikes,
    canAct,
    // The queue and the selected suspect sit side by side, which needs the full content width.
    wide: true,
  };
};

type Scope = 'report' | 'strike' | 'notify' | 'images';
const scopedFail = (scope: Scope, message: string) => fail(400, { scope, error: message });

const idsSchema = z.object({
  imageIds: z
    .string()
    .transform((s) => parseIdList(s, 5001))
    .refine((ids) => ids.length > 0, 'Select at least one image.')
    .refine((ids) => ids.length <= 5000, 'Too many images in one batch — narrow the selection.'),
});

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

  // Retool's strikeCheckbox path: acting on a report means removing the images it is about, from the
  // same screen. The endpoints are the ones Bulk Image Manager uses.
  remove: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('images', 'Not permitted.');
    const input = parseForm(
      idsSchema.extend({
        reason: z.string().trim().max(500).optional(),
        violationType: z.enum(VIOLATION_TYPES).optional(),
        // Retool's TosReasons carried a flag alongside the message; setting it is part of the same
        // gesture, so a POI removal does not need a second pass to mark the images.
        alsoFlag: z.enum(['poi', 'minor', 'tag']).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('images', input);

    const result = await removeImages({
      imageIds: input.imageIds,
      reason: input.reason || undefined,
      violationType: input.violationType,
      moderatorId: locals.user.id,
    });

    // The flag the canned reason implies, applied in the same gesture. Best-effort: the removal has
    // already landed, so a flag failure must not report the removal as failed.
    if (input.alsoFlag === 'poi' || input.alsoFlag === 'minor')
      await setImageFlag({
        imageIds: input.imageIds,
        flag: input.alsoFlag,
        value: true,
        moderatorId: locals.user.id,
      });
    // The SERVER's count, not the submitted one: a partial removal must not read as a full one.
    if (!result.ok) return scopedFail('images', result.error);
    return { success: true, imageResult: `Removed ${result.count} of ${input.imageIds.length}.` };
  },

  restore: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('images', 'Not permitted.');
    const input = parseForm(idsSchema, await request.formData());
    if (typeof input === 'string') return scopedFail('images', input);

    const result = await restoreImages({ imageIds: input.imageIds, moderatorId: locals.user.id });
    if (!result.ok) return scopedFail('images', result.error);
    return { success: true, imageResult: `Restored ${result.count} of ${input.imageIds.length}.` };
  },

  setFlag: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('images', 'Not permitted.');
    const input = parseForm(
      idsSchema.extend({
        flagValue: z.enum(['poi:true', 'poi:false', 'minor:true', 'minor:false']),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('images', input);

    const [flag, value] = input.flagValue.split(':');
    const result = await setImageFlag({
      imageIds: input.imageIds,
      flag: flag as 'poi' | 'minor',
      value: value === 'true',
      moderatorId: locals.user.id,
    });
    if (!result.ok) return scopedFail('images', result.error);
    return { success: true, imageResult: `Updated ${input.imageIds.length} images.` };
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
