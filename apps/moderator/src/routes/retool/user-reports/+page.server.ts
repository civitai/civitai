import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { DEFAULT_REPORT_REASONS, ReportEntity } from '$lib/reports';
import { getReportHistory, getReports } from '$lib/server/reports.service';
import { getSuspectImages } from '$lib/server/report-triage.service';
import { reportModerationActions } from '$lib/server/report-actions';
import { parseReportQueueFilters, reportQueueFilterSchema } from '$lib/server/report-queue-filters';
import { ingestionErrorLevelSet } from '@civitai/shared';
import { loadAccountHistory } from '$lib/server/account-history';

// `user` opens the drill-down for one suspect, in the URL so a moderator can hand a colleague the exact
// queue position they are looking at.
const boolParam = z
  .string()
  .optional()
  .transform((v) => v === '1');

// The IMAGE grid's date bounds, which are this page's alone — the queue's live in
// `report-queue-filters.ts`. Kept apart because the semantics differ: `to` here is INCLUSIVE, so a
// date-only value has to reach the end of the day picked rather than midnight at its start.
const imageDateParam = z
  .string()
  .optional()
  .transform((v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  });
const endOfDayParam = imageDateParam.transform((d) =>
  d ? new Date(d.getTime() + (d.getTime() % 86_400_000 === 0 ? 86_399_999 : 0)) : null
);

const querySchema = z
  .object({
    user: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
    page: z.coerce.number().int().positive().max(10_000).catch(1),
    imgPage: z.coerce.number().int().positive().max(10_000).catch(1),
    tos: boolParam,
    noPrompt: boolParam,
    // Absent means every rating. 0 is allowed on purpose — an unrated image has no browsing level —
    // which is why the absent case is guarded before the split: `''.split(',')` maps to `[0]`, and
    // that filters to unrated-only rather than to everything.
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
    from: imageDateParam,
    to: endOfDayParam,
    prompt: z.string().trim().max(200).catch(''),
    negativePrompt: z.string().trim().max(200).catch(''),
  })
  .extend(reportQueueFilterSchema.shape);

const PER_PAGE = 50;

export const load: PageServerLoad = async ({ url, locals }) => {
  const parsed = parseQuery(url, querySchema);
  const queue = parseReportQueueFilters(url, parsed);
  const { user, page, imgPage, tos, noPrompt, levels, from, to, prompt, negativePrompt } = parsed;

  const filters = { tosOnly: tos, noPrompt, levels, from, to, prompt, negativePrompt };
  // Reaching the queue is an investigation permission; acting on a report or an account is not.
  const canAct = canAccess(locals.user, '/users');

  const [reports, history, suspect, accountHistory] = await Promise.all([
    // The SAME query `/reports/user` runs. A parallel one diverged from the sidebar's counts on which
    // reasons it excluded, so the badge and this heading disagreed about one queue.
    getReports({
      type: ReportEntity.User,
      page,
      limit: PER_PAGE,
      // An empty selection is every status, said explicitly rather than implied by omission.
      statuses: queue.statuses.length ? queue.statuses : 'all',
      reasons: DEFAULT_REPORT_REASONS,
      reportedBy: queue.reportedBy || undefined,
      from: queue.from,
      to: queue.to,
    }),
    getReportHistory(ReportEntity.User),
    user ? getSuspectImages(user, filters, { page: imgPage }) : null,
    // Retool's top-left was three tabs — ModActivity / Reports / UserReport History — and the whole
    // point of this screen is not leaving it.
    user ? loadAccountHistory(user, locals.user.username ?? null) : null,
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
    queueFilters: queue.echo,
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
    accountHistory,
    canAct,
    // The queue and the selected suspect sit side by side, which needs the full content width.
    // Not `wide`: this page owns its own height so the queue column can be sized against the
    // viewport. Under `wide` the column started 136px down the page and a `100vh` height then
    // hung 104px below the fold, taking the pager with it — CSS cannot read its own offset, so
    // the header has to be a sibling of the panes rather than something above them.
    fullBleed: true,
  };
};

export const actions = reportModerationActions('/users');
