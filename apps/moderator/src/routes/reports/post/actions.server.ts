import { fail, type RequestEvent } from '@sveltejs/kit';
import { setReportStatus } from '$lib/server/reports.service';
import { getResolvedPostReportIds } from '$lib/server/moderation-board.service';
import { reportModerationActions } from '$lib/server/report-actions';
import { ReportEntity, ReportStatus, reportPath } from '$lib/reports';

// The post queue's forms, taken by both pages that render a post — the bare queue and `[postId]`:
// ruling on a report, the post's images, and a strike or notification for its owner (the shared report
// actions: the report on this page's path, the images and the owner on their action grants), plus the
// queue's own sweep.
export const postQueueActions = {
  ...reportModerationActions(reportPath(ReportEntity.Post)),

  /**
   * Retool's `ActionAllPostReports`. Post reports whose post is already entirely blocked are resolved
   * by the content — the row is open only because nobody clicked it. Retool swept them in one go; the
   * port had the verb (`setStatus`) and not the SELECT, so the sweep had to be done by hand.
   *
   * Actioned, not Unactioned: the content WAS removed, so the report was correct.
   */
  actionResolvedPosts: async ({ locals, getClientAddress }: RequestEvent) => {
    const ids = await getResolvedPostReportIds();
    if (!ids.length)
      return fail(400, { error: 'No post reports are already resolved by content.' });

    // `setReportStatus` RETURNS its outcome rather than throwing: `ok:false` when the report is gone,
    // and `ok:true, changed:false` when someone else already put it in this status. Counting the loop
    // instead of the results reported "actioned N of N" for a run that changed nothing.
    let actioned = 0;
    let skipped = 0;
    for (const id of ids) {
      const result = await setReportStatus({
        id,
        status: ReportStatus.Actioned,
        userId: locals.user.id,
        ip: getClientAddress(),
      });
      if (result.ok && result.changed) actioned += 1;
      else skipped += 1;
    }

    // The SELECT is capped, so a full batch means there are probably more behind it.
    return { success: true, actioned, skipped, found: ids.length, more: ids.length === 500 };
  },
};
