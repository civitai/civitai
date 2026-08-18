import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseIdList, parseQuery, userIdSchema } from '$lib/server/query';
import {
  issueStrike,
  removeImages,
  restoreImages,
  setImageFlag,
} from '$lib/server/user-actions.service';
import { countBlockedImages, strikeBatchOwners } from '$lib/server/bulk-image.service';
import { VIOLATION_TYPES } from '$lib/violations';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import {
  DEFAULT_REPORT_REASONS,
  ReportEntity,
  ReportStatus,
  DEFAULT_REPORT_STATUSES,
  isReportStatus,
} from '$lib/reports';
import { getReportHistory, getReports, setReportStatus } from '$lib/server/reports.service';
import {
  getUserNotes,
  getUserStrikes,
  sendModNotification,
} from '$lib/server/moderation-memory.service';
import { getSuspectImages } from '$lib/server/report-triage.service';
import { getLiveStrikes } from '$lib/server/user-lookup.service';
import { getModActivity } from '$lib/server/user-account.service';
import { getReportsOnUser } from '$lib/server/user-reports.service';
import { imageFlagValueSchema, splitImageFlagValue } from '$lib/image-flags';
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

// Two upper bounds with DIFFERENT semantics, named so the difference is readable at the field rather
// than hidden in a magic constant. The image grid's `to` is INCLUSIVE — a date-only value parses as
// midnight, which would otherwise exclude the whole day picked. The queue's `reportedTo` is EXCLUSIVE,
// matching the contract `getReports` documents.
const endOfDayParam = dateParam.transform((d) =>
  d ? new Date(d.getTime() + (d.getTime() % 86_400_000 === 0 ? 86_399_999 : 0)) : null
);
const nextDayParam = dateParam.transform((d) => (d ? new Date(d.getTime() + 86_400_000) : null));

const querySchema = z.object({
  user: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  page: z.coerce.number().int().positive().max(10_000).catch(1),
  cursor: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  tos: boolParam,
  noPrompt: boolParam,
  // Absent means every rating, so an unticked box set and a fully ticked one read the same. 0 is
  // allowed on purpose: an unrated image has no browsing level, and without it ticking every box
  // silently drops exactly the images no scanner has judged yet.
  // `(v ?? '').split(',')` yields `['']` -> `[0]`, and 0 is a MEANINGFUL level here (unrated), so the
  // filter kept it: with no `levels` in the URL every grid showed `nsfwLevel in (0)` and reported the
  // account as having no images at all. Guard the absent case before splitting.
  levels: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map(Number)
            .filter((n) => n === 0 || ingestionErrorLevelSet.has(n))
        : []
    ),
  from: dateParam,
  to: endOfDayParam,
  prompt: z.string().trim().max(200).catch(''),
  negativePrompt: z.string().trim().max(200).catch(''),
  // Queue filters. Named apart from the image `from`/`to` above, which describe the OPEN ACCOUNT'S
  // content — one pair of date params driving both would silently re-filter the grid every time a
  // moderator narrowed the queue.
  reportedBy: z.string().trim().max(100).catch(''),
  reportedFrom: dateParam,
  reportedTo: nextDayParam,
});

const PER_PAGE = 50;

export const load: PageServerLoad = async ({ url, locals }) => {
  const {
    user,
    page,
    cursor,
    tos,
    noPrompt,
    levels,
    from,
    to,
    prompt,
    negativePrompt,
    reportedBy,
    reportedFrom,
    reportedTo,
  } = parseQuery(url, querySchema);

  const urlStatuses = url.searchParams.getAll('status').filter(isReportStatus);
  const queueStatuses = url.searchParams.has('status') ? urlStatuses : DEFAULT_REPORT_STATUSES;
  const filters = { tosOnly: tos, noPrompt, levels, from, to, prompt, negativePrompt };
  // Reaching the queue is an investigation permission; acting on a report or an account is not.
  const canAct = canAccess(locals.user, '/users');

  const [reports, history, suspect, strikes, legacyStrikes, notes, modActivity, reportsOnUser] =
    await Promise.all([
      // The SAME query `/reports/user` runs. A parallel one diverged from the sidebar's counts on which
      // reasons it excluded, so the badge and this heading disagreed about one queue.
      getReports({
        type: ReportEntity.User,
        page,
        limit: PER_PAGE,
        // An empty selection is every status, said explicitly rather than implied by omission.
        statuses: queueStatuses.length ? queueStatuses : 'all',
        reasons: DEFAULT_REPORT_REASONS,
        reportedBy: reportedBy || undefined,
        from: reportedFrom ?? undefined,
        to: reportedTo ?? undefined,
      }),
      getReportHistory(ReportEntity.User),
      user ? getSuspectImages(user, filters, { cursor }) : null,
      // The MAIN APP's strikes, not the moderator database's Retool-era table — that one is written by
      // nothing, so this panel read 0 on an account carrying ten live strikes, which is the worst
      // possible number to be wrong about on the screen where the next one is issued.
      user ? getLiveStrikes(user) : null,
      user ? getUserStrikes(user) : null,
      // Retool put the suspect's notes on this page. "Shipped in User Lookup" is true of the dataset and
      // false of this screen: deciding on a strike without the prior note is the thing notes exist to stop.
      user ? getUserNotes(user, locals.user.username ?? null) : null,
      // Retool's top-left was three tabs — ModActivity / Reports / UserReport History — and the whole
      // point of this screen is not leaving it. Strikes and notes were already here; these two are what
      // "has anyone dealt with this account before" actually reads.
      user ? getModActivity(user, 20) : null,
      // Every status, not the open ones: the queue row above is the open report. What is missing here is
      // whether this account has been reported and RULED ON before.
      //
      // Human-filed only, matching the queue's own definition. `Automated` is 99.9% of this table — one
      // dev account carries 556 of them — so an unfiltered list of 20 is 20 Clavata rows and answers
      // nothing about whether a person has complained about this account before.
      user
        ? getReportsOnUser(user, { limit: 20, statuses: [], reasons: DEFAULT_REPORT_REASONS })
        : null,
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
    // Echoed back so the control shows what is actually applied. `reportedTo` is the exclusive bound
    // the query used, so the raw param goes back rather than the parsed date.
    queueFilters: {
      statuses: queueStatuses,
      reportedBy,
      reportedFrom: url.searchParams.get('reportedFrom') ?? '',
      reportedTo: url.searchParams.get('reportedTo') ?? '',
    },
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
    legacyStrikeCount: legacyStrikes?.length ?? 0,
    notes,
    modActivity,
    reportsOnUser,
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

  // Retool's InsertStrike + LogStrike + InsertStrikeNotif. Writes the MAIN APP's strike system, like
  // User Lookup does: a row in the moderator database's legacy `UserStrikes` gets no escalation,
  // points, expiry, typed notification or void path. See issueStrike.
  strike: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('strike', 'Not permitted.');

    const input = parseForm(
      userIdSchema.extend({ reason: z.string().trim().min(1).max(1000) }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('strike', input);

    const result = await issueStrike({
      userId: input.userId,
      description: input.reason,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return scopedFail('strike', result.error);
    // No "could not notify" branch: `createStrike` sends the typed notification and its email inside
    // the same call, so there is no separate step here to half-fail.
    return { success: true };
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
        // Retool's strikeCheckbox. `z.coerce.boolean()` would read the string "false" as true, and a
        // checkbox is absent-or-its-value, so match the value it posts.
        strikeOwners: z
          .literal('1')
          .optional()
          .transform((v) => v === '1'),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('images', input);
    // Refused BEFORE the removal: after it, the images are gone and the other half of the gesture
    // cannot be retried from here.
    if (input.strikeOwners && !input.reason)
      return scopedFail('images', 'A strike needs a reason — it is the message the user is sent.');

    // BEFORE the write, or every id reads as already-blocked afterwards.
    const alreadyBlocked = await countBlockedImages(input.imageIds);

    const result = await removeImages({
      imageIds: input.imageIds,
      reason: input.reason || undefined,
      violationType: input.violationType,
      moderatorId: locals.user.id,
    });

    // The SERVER's count, not the submitted one: a partial removal must not read as a full one.
    if (!result.ok) return scopedFail('images', result.error);

    // ONLY once the removal has landed. Run before that check, a failed removal still flagged every
    // submitted id — thousands of images marked POI under a red "removal failed" banner.
    const flagged =
      input.alsoFlag === 'poi' || input.alsoFlag === 'minor'
        ? await setImageFlag({
            imageIds: input.imageIds,
            flag: input.alsoFlag,
            value: true,
            moderatorId: locals.user.id,
          })
        : null;

    // A silent flag failure is worse than none: the moderator believes the images are marked. `tag`
    // is offered by the reason list but is not an image flag, so say that rather than drop it.
    const flagNote =
      flagged && !flagged.ok
        ? ` The ${input.alsoFlag} flag was NOT applied: ${flagged.error}`
        : input.alsoFlag === 'tag'
        ? ' Note: "tag" is not an image flag and was not applied.'
        : '';

    // Same ordering as the flag: a failed removal must not strike anybody.
    const struck =
      input.strikeOwners && input.reason
        ? await strikeBatchOwners({
            imageIds: input.imageIds,
            description: input.reason,
            moderatorId: locals.user.id,
          })
        : null;

    const strikeNote = struck
      ? struck.error
        ? ` Struck ${struck.struck} of ${struck.owners} owners: ${struck.error}`
        : ` Struck ${struck.struck} owner${struck.struck === 1 ? '' : 's'}.`
      : '';

    return {
      success: true,
      // The endpoint counts rows FOUND; the already-blocked share is subtracted so re-removing a
      // blocked batch cannot report a full removal.
      imageResult:
        `Removed ${result.count - alreadyBlocked} of ${input.imageIds.length}` +
        `${
          alreadyBlocked > 0 ? ` (${alreadyBlocked} already blocked)` : ''
        }.${flagNote}${strikeNote}`,
    };
  },

  restore: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('images', 'Not permitted.');
    const input = parseForm(idsSchema, await request.formData());
    if (typeof input === 'string') return scopedFail('images', input);

    const wasBlocked = await countBlockedImages(input.imageIds);

    const result = await restoreImages({ imageIds: input.imageIds, moderatorId: locals.user.id });
    if (!result.ok) return scopedFail('images', result.error);
    return {
      success: true,
      imageResult:
        `Restored ${result.count} of ${input.imageIds.length}` +
        `${result.count > wasBlocked ? ` (${result.count - wasBlocked} were not blocked)` : ''}.`,
    };
  },

  setFlag: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return scopedFail('images', 'Not permitted.');
    const input = parseForm(
      idsSchema.extend({
        flagValue: imageFlagValueSchema,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return scopedFail('images', input);

    const result = await setImageFlag({
      ...splitImageFlagValue(input.flagValue),
      imageIds: input.imageIds,
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
