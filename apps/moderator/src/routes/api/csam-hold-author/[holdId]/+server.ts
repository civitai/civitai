import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam, requirePermission } from '$lib/server/api-guard';
import { getHoldAuthorHolds } from '$lib/server/csam-holds.queries';
import { canSeeUserCard } from '$lib/server/user-card';
import { getCounts, getReportedContent, getUserCard } from '$lib/server/user-lookup.service';

// Each part degrades on its own: a failing count must not hide who the author is.
const orNull = <T>(read: Promise<T>) =>
  read.catch((err) => {
    console.error('CSAM hold author lookup failed', err);
    return null;
  });

// Loaded for the selected hold only: the counts are one query per content type, and the queue switches
// holds without rerunning the page load. The hold history needs the page and `csam.report.file`; the
// account card, content counts and reports are User Lookup's, so they go only to a moderator who could
// open that page anyway.
export const GET: RequestHandler = async ({ params, locals }) => {
  const holdId = requireIdParam(locals, params.holdId, '/csam/text-holds', 'holdId');
  requirePermission(locals, 'csam.report.file');

  const holds = await getHoldAuthorHolds(holdId);
  if (!holds) error(404, 'No author on this hold.');

  const { userId } = holds;
  const [card, counts, reportedContent] = canSeeUserCard(locals)
    ? await Promise.all([
        orNull(getUserCard(userId)),
        orNull(getCounts(userId)),
        orNull(getReportedContent(userId)),
      ])
    : [null, null, null];

  return json({
    userId,
    card,
    counts,
    reportedContent,
    holds: { total: holds.total, others: holds.others },
  });
};
