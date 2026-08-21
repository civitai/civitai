import { z } from 'zod';
import { DEFAULT_REPORT_STATUSES, isReportStatus, type ReportStatus } from '$lib/reports';

/**
 * The READ half of `$lib/components/ReportQueueFilterBar.svelte`.
 *
 * The bar writes these params; this parses them. They are two halves of one contract and drift here
 * produces the worst kind of bug — a filter chip that visibly toggles and changes nothing, so the UI
 * says it worked. Sharing the bar without sharing the parser is what left that possible.
 */

const dateParam = z
  .string()
  .optional()
  .transform((v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  });

/** `getReports`'s `to` is EXCLUSIVE, so a date-only value becomes the next midnight — a `<=` on the date
 *  itself would drop everything reported after midnight on the day picked. */
const nextDayParam = dateParam.transform((d) => (d ? new Date(d.getTime() + 86_400_000) : null));

export const reportQueueFilterSchema = z.object({
  reportedBy: z.string().trim().max(100).catch(''),
  reportedFrom: dateParam,
  reportedTo: nextDayParam,
});

export type ReportQueueFilters = {
  statuses: ReportStatus[];
  reportedBy: string;
  from: Date | undefined;
  to: Date | undefined;
  /** Echoed to the control so it shows what is actually applied. `reportedTo` is the raw param, not the
   *  exclusive bound the query used, or the date input would render the day after the one chosen. */
  echo: { statuses: ReportStatus[]; reportedBy: string; reportedFrom: string; reportedTo: string };
};

/**
 * An ABSENT `?status=` is the default review view; a present-but-empty one is a deliberate clear and
 * means every status. The bar writes `?status=` for exactly that reason (`emptyMeansAll`), so reading an
 * absent param as "all" would silently reapply the default over a cleared filter.
 */
export function parseReportQueueFilters(
  url: URL,
  parsed: z.infer<typeof reportQueueFilterSchema>
): ReportQueueFilters {
  const urlStatuses = url.searchParams.getAll('status').filter(isReportStatus);
  const statuses = url.searchParams.has('status') ? urlStatuses : DEFAULT_REPORT_STATUSES;

  return {
    statuses,
    reportedBy: parsed.reportedBy,
    from: parsed.reportedFrom ?? undefined,
    to: parsed.reportedTo ?? undefined,
    echo: {
      statuses,
      reportedBy: parsed.reportedBy,
      reportedFrom: url.searchParams.get('reportedFrom') ?? '',
      reportedTo: url.searchParams.get('reportedTo') ?? '',
    },
  };
}
