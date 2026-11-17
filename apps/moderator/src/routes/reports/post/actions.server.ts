import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { canAccess } from '$lib/server/access';
import { postTextActionAllowed, type PostTextAction } from '$lib/post-text-report';
import { getReportPostTextId, moderatePostText } from '$lib/server/post-text-reports.service';
import { parseForm } from '$lib/server/query';
import { setReportStatus } from '$lib/server/reports.service';
import { MAX_INT4 } from '$lib/server/users.service';
import { getResolvedPostReportIds } from '$lib/server/moderation-board.service';
import { reportModerationActions } from '$lib/server/report-actions';
import { ReportEntity, ReportStatus, reportPath } from '$lib/reports';

const textFormSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_INT4),
  reason: z.string().trim().min(1, 'Say why.').max(500),
});

/** The report each text action leaves behind it: upheld by a refusal or a hold, dismissed by a restore. */
const TEXT_ACTION_RULING: Record<PostTextAction, ReportStatus> = {
  refuse: ReportStatus.Actioned,
  hold: ReportStatus.Actioned,
  restore: ReportStatus.Unactioned,
};

const TEXT_ACTION_DONE: Record<PostTextAction, [changed: string, unchanged: string]> = {
  refuse: ['Text refused', 'Already refused'],
  hold: ['Held for CSAM review', 'Already held for CSAM review'],
  restore: ['Text restored', 'Not refused by a moderator'],
};

/**
 * One report's text, refused, restored or sent to the CSAM text-hold queue through the main app
 * (which writes the audit row), then the report ruled on as the other report actions do, which pays
 * its reporters when upheld. The text is the one the report names, never one the form names.
 */
const textAction =
  (action: PostTextAction) =>
  async ({ request, locals, getClientAddress }: RequestEvent) => {
    if (!canAccess(locals.user, reportPath(ReportEntity.Post)))
      return fail(403, { scope: 'text', error: 'Not permitted.' });
    const input = parseForm(textFormSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'text', error: input });

    const report = await getReportPostTextId(input.id);
    if (!report)
      return fail(410, { scope: 'text', error: 'That report no longer exists.', gone: true });
    if (report.postTextId == null)
      return fail(410, { scope: 'text', error: 'That text no longer exists.', gone: true });
    if (!postTextActionAllowed(action, report))
      return fail(400, {
        scope: 'text',
        error:
          action === 'hold'
            ? 'Only a CSAM or minor-sexualization report goes to the CSAM queue.'
            : 'A CSAM or minor-sexualization report goes to the CSAM queue, not a refusal.',
      });

    const result = await moderatePostText({
      textId: report.postTextId,
      action,
      reason: input.reason,
      reportId: input.id,
    });
    if (!result.ok) return fail(409, { scope: 'text', error: result.error });
    // Nothing done: the report is left for a moderator to rule on as it stands.
    if (!result.changed && action === 'restore')
      return { success: true, textAction: TEXT_ACTION_DONE[action][1] };

    const ruled = await setReportStatus({
      id: input.id,
      status: TEXT_ACTION_RULING[action],
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    const done =
      action === 'restore' && result.stillRefused
        ? 'Restored, but the scan still refuses it'
        : TEXT_ACTION_DONE[action][result.changed ? 0 : 1];
    if (!ruled.ok)
      return fail(410, { scope: 'text', error: `${done}, but ${ruled.error}`, gone: true });
    return { success: true, textAction: done };
  };

// The post queue's forms, taken by both pages that render a post — the bare queue and `[postId]`:
// ruling on a report, the post's images, and a strike or notification for its owner (the shared report
// actions: the report on this page's path, the images and the owner on their action grants), plus the
// queue's own sweep.
export const postQueueActions = {
  ...reportModerationActions(reportPath(ReportEntity.Post)),

  refuseText: textAction('refuse'),
  restoreText: textAction('restore'),
  holdText: textAction('hold'),

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
