import { redirect } from '@sveltejs/kit';
import { getReports, getReportStatusCounts } from './reports.service';
import { parseQueryKeys } from './query';
import { MAX_INT4, usersByIds } from './users.service';
import type { AdditionalReporter } from '$lib/components/report-queue/report-list';
import { parseReportQueueFilters, reportQueueFilterSchema } from './report-queue-filters';
import { isModelUnpublishReason } from '$lib/model-unpublish-reasons';
import {
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_STATUSES,
  reportReasons,
  type ReportEntity,
  type ReportReason,
} from '$lib/reports';

const isReason = (v: string): v is ReportReason => (reportReasons as string[]).includes(v);

type LoadReportQueueOptions = {
  /** Per-status counts, for a queue whose status filter shows them (`ReportFilters`). */
  statusCounts?: boolean;
  /** Write the default statuses into the URL on a bare landing. The tables do; see below. */
  canonicalize?: boolean;
  /** Apply `reportedFrom`/`reportedTo`. Off for a queue with no date inputs, where a date left in a
   *  pasted URL would be a filter with no control showing it. */
  dates?: boolean;
  /** Apply `?unpublished=<reason>`: the reports filed on posts made with a model unpublished for it. */
  unpublished?: boolean;
  limit?: number;
};

/**
 * One report queue's rows and the filter state they were read with — the ONE reader of a queue's URL,
 * for the `/reports/[slug]` tables and the queue layouts (user, model, post, and the shared
 * `/reports/[queue=entityQueue]`). Filter parsing is
 * `parseReportQueueFilters`, shared with the Retool post-report queue.
 *
 * 🔴 Reads the URL through `searchParams.get`/`getAll`/`has` only. SvelteKit tracks those per key, and
 * every queue layout (user, model, post, the shared entity route) is a LAYOUT so it does not rerun
 * when the open item (the path) changes.
 * Iterating the query string or reading the path here would make them rerun on every click.
 */
export async function loadReportQueue(
  type: ReportEntity,
  url: URL,
  {
    statusCounts: withStatusCounts = false,
    canonicalize = true,
    dates = false,
    unpublished = false,
    limit,
  }: LoadReportQueueOptions = {}
) {
  // `?report=<id>` opens ONE report, from a page that could only list it. Every filter is forced off:
  // a report linked to from elsewhere is usually already handled, and landing on an empty list because
  // the default view is Pending+Processing reads as "that report does not exist".
  const reportParam = Number(url.searchParams.get('report'));
  const reportId =
    Number.isInteger(reportParam) && reportParam > 0 && reportParam <= MAX_INT4
      ? reportParam
      : undefined;

  // The tables canonicalize a bare landing so the active default filters are explicit (and shareable)
  // in the URL. The model and user queues do not: their status control (`ReportFilters`) shows the
  // default as selected without it, and the defaults spelled out in every URL — model links included —
  // read as filters someone had set. Either way only an ABSENT param gets the default; a present-but-
  // empty `?status=` is a deliberate clear, meaning every status.
  // Reading the whole URL here is fine: this run redirects, so nothing it tracked is kept.
  if (canonicalize && !reportId && !url.searchParams.has('status')) {
    const canonical = new URL(url);
    DEFAULT_REPORT_STATUSES.forEach((s) => canonical.searchParams.append('status', s));
    redirect(307, canonical.pathname + canonical.search);
  }

  const page = Math.min(10_000, Math.max(1, Math.floor(Number(url.searchParams.get('page'))) || 1));
  const filters = parseReportQueueFilters(url, parseQueryKeys(url, reportQueueFilterSchema));
  const urlReasons = url.searchParams.getAll('reason').filter(isReason);
  // A present-but-empty `?reason=` is an explicit clear → all; an absent one → the default review view.
  // Both defaults must stay equal to what the badge counts, or a moderator lands on a list that
  // disagrees with the number they clicked.
  const reasons = url.searchParams.has('reason') ? urlReasons : DEFAULT_REPORT_REASONS;
  const unpublishedParam = unpublished ? url.searchParams.get('unpublished') ?? '' : '';
  const unpublishedReason =
    !reportId && isModelUnpublishReason(unpublishedParam) ? unpublishedParam : undefined;

  const queueFilters = {
    type,
    // An empty selection is every one, said explicitly rather than implied by omission.
    reasons: reportId ? ('all' as const) : reasons.length ? reasons : ('all' as const),
    reportedBy: reportId ? undefined : filters.reportedBy || undefined,
    from: reportId || !dates ? undefined : filters.from,
    to: reportId || !dates ? undefined : filters.to,
    unpublishedReason,
    reportId,
  };
  const [data, statusCounts] = await Promise.all([
    getReports({
      ...queueFilters,
      page: reportId ? 1 : page,
      limit,
      statuses: reportId ? 'all' : filters.statuses.length ? filters.statuses : 'all',
    }),
    // For a queue with status chips; the tables have no such control.
    withStatusCounts ? getReportStatusCounts(queueFilters) : {},
  ]);

  // The default reason set is NOT echoed into the filter control: eight pre-ticked chips read as a
  // heavily-narrowed view when it is the ordinary one. The page says what it is hiding instead, and only
  // while it is hiding it — once reasons are chosen explicitly, the choice is the whole story.
  return {
    type,
    // A `?report=` view ran with no filter, so echoing the defaults would put chips saying "Pending +
    // Processing" above an Actioned row and a note about hiding Automated above an Automated one — the
    // operator reads that as the filters being broken.
    statuses: reportId ? [] : filters.statuses,
    statusCounts,
    reasons: reportId ? [] : urlReasons,
    hidingAutomated: !reportId && !url.searchParams.has('reason'),
    reportedBy: filters.echo.reportedBy,
    // The raw params, not the bounds the query used: `reportedTo` is exclusive there, and echoing that
    // would render the day after the one chosen.
    reportedFrom: filters.echo.reportedFrom,
    reportedTo: filters.echo.reportedTo,
    singleReport: reportId ?? null,
    unpublishedReason: unpublishedReason ?? null,
    ...data,
    items: await withAdditionalReporters(data.items),
  };
}

export type ReportQueueData = Awaited<ReturnType<typeof loadReportQueue>>;

type AdditionalReport = {
  userId?: unknown;
  createdAt?: unknown;
  details?: Record<string, unknown>;
};

const additionalReports = (details: unknown): AdditionalReport[] => {
  const list = (details as { additionalReports?: unknown } | null)?.additionalReports;
  return Array.isArray(list) ? (list as AdditionalReport[]) : [];
};
const words = (d: Record<string, unknown> | undefined) => {
  for (const key of ['comment', 'violation', 'reason']) {
    const v = d?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
};

/**
 * Each report's other reporters, with their names. A report filed by several people keeps one row and
 * folds the rest into `details.additionalReports` — each with its own comment, which a moderator could
 * only read by opening the raw details, and with a user id where they need a name.
 */
export async function withAdditionalReporters<R extends { details: unknown }>(items: R[]) {
  const ids = items.flatMap((r) =>
    additionalReports(r.details).flatMap((a) => (typeof a.userId === 'number' ? [a.userId] : []))
  );
  const users = ids.length ? await usersByIds(ids) : new Map();
  return items.map((r) => ({
    ...r,
    additionalReporters: additionalReports(r.details).flatMap((a): AdditionalReporter[] =>
      typeof a.userId === 'number'
        ? [
            {
              userId: a.userId,
              username: users.get(a.userId)?.username ?? null,
              createdAt: typeof a.createdAt === 'string' ? a.createdAt : null,
              comment: words(a.details),
            },
          ]
        : []
    ),
  }));
}

/**
 * Every open, human-filed report about one item, for the open item's report list. The item's own
 * query rather than the queue page's rows: a second report on the same account or model can sit on
 * another page, and a ruling made without it left that one open.
 */
export async function loadItemReports(type: ReportEntity, entityId: number) {
  const { items } = await getReports({
    type,
    entityId,
    statuses: DEFAULT_REPORT_STATUSES,
    reasons: DEFAULT_REPORT_REASONS,
    limit: 100,
  });
  return withAdditionalReporters(items);
}
