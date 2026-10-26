import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam, requirePermission } from '$lib/server/api-guard';
import { DEFAULT_REPORT_REASONS } from '$lib/reports';
import { getHoldAuthorHolds } from '$lib/server/csam-holds.queries';
import { canSeeUserCard } from '$lib/server/user-card';
import { getCounts, getReportedContent, getUserCard } from '$lib/server/user-lookup.service';
import { getReportsReceived } from '$lib/server/user-reports.service';

/** The latest reports on the author's content the card lists; the counts and User Lookup carry the rest. */
const RECENT_REPORTS = 5;

// Each part degrades on its own: a failing count must not hide who the author is.
const orNull = <T>(read: Promise<T>) =>
  read.catch((err) => {
    console.error('CSAM hold author lookup failed', err);
    return null;
  });

// Per selected hold: the counts cost one query per content type. History needs the page and csam.report.file; account card, counts and reports are User Lookup's, so only moderators who can open it get them.
export const GET: RequestHandler = async ({ params, locals }) => {
  const holdId = requireIdParam(locals, params.holdId, '/csam/text-holds', 'holdId');
  requirePermission(locals, 'csam.report.file');

  const holds = await getHoldAuthorHolds(holdId);
  if (!holds) error(404, 'No author on this hold.');

  const { userId } = holds;
  const [card, counts, reportedContent, recentReports] = canSeeUserCard(locals)
    ? await Promise.all([
        orNull(getUserCard(userId)),
        orNull(getCounts(userId)),
        orNull(getReportedContent(userId)),
        // Human-filed only, as the account panel shows them: Automated is most of the corpus.
        orNull(getReportsReceived(userId, { limit: RECENT_REPORTS, reasons: DEFAULT_REPORT_REASONS })),
      ])
    : [null, null, null, null];

  return json({
    userId,
    card,
    counts,
    reportedContent,
    recentReports,
    holds: { total: holds.total, pendingTotal: holds.pendingTotal, others: holds.others },
  });
};
