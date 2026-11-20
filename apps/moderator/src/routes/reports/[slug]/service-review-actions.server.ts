import { fail, type RequestEvent } from '@sveltejs/kit';
import { canAccess } from '$lib/server/access';
import { setReportStatus } from '$lib/server/reports.service';
import {
  getReportServiceReview,
  moderateServiceReview,
} from '$lib/server/service-review-reports.service';
import {
  serviceReviewActionAllowed,
  type ServiceReviewAction,
  type ServiceReviewText,
} from '$lib/service-review-report';
import { reportEntityForSlug, reportPath, ReportStatus } from '$lib/reports';

/** The report each review action leaves behind it: upheld by a hide or a hold, dismissed by a restore. */
const REVIEW_ACTION_RULING: Record<ServiceReviewAction, ReportStatus> = {
  hide: ReportStatus.Actioned,
  hold: ReportStatus.Actioned,
  restore: ReportStatus.Unactioned,
};

const REVIEW_ACTION_DONE: Record<ServiceReviewAction, [changed: string, unchanged: string]> = {
  hide: ['Review hidden', 'Already hidden'],
  hold: ['Held for CSAM review', 'Already held for CSAM review'],
  restore: ['Review restored', 'Not hidden by a moderator'],
};

/**
 * One report's buyer review, hidden, restored or one of its texts sent to the CSAM text-hold queue
 * through the main app (which writes the audit row), then the report ruled on, which pays its
 * reporters when upheld. The review is the one the report names, never one the form names.
 */
const reviewAction =
  (action: ServiceReviewAction) =>
  async ({ request, locals, params, getClientAddress }: RequestEvent<{ slug: string }>) => {
    const type = reportEntityForSlug(params.slug);
    if (type !== 'serviceOffering' || !canAccess(locals.user, reportPath(type)))
      return fail(403, { error: 'Not permitted.' });

    const data = await request.formData();
    const id = Number(data.get('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid report.' });
    const textField = data.get('text');
    const text: ServiceReviewText | undefined =
      textField === 'comment' || textField === 'reply' ? textField : undefined;
    if (action === 'hold' && !text) return fail(400, { error: 'Pick the text to hold.' });

    const report = await getReportServiceReview(id);
    if (!report) return fail(410, { error: 'That report no longer exists.', gone: true });
    if (!serviceReviewActionAllowed(action, report))
      return fail(400, {
        error:
          action === 'hold'
            ? 'Only a CSAM or minor-sexualization report goes to the CSAM queue.'
            : 'A CSAM or minor-sexualization report goes to the CSAM queue, not a hide.',
      });

    const result = await moderateServiceReview({
      reviewId: report.reviewId,
      action,
      text,
      reportId: id,
    });
    if (!result.ok) return fail(409, { error: result.error });
    // Nothing done: the report is left for a moderator to rule on as it stands.
    if (!result.changed && action === 'restore')
      return { success: true, serviceReviewAction: REVIEW_ACTION_DONE[action][1] };

    const ruled = await setReportStatus({
      id,
      status: REVIEW_ACTION_RULING[action],
      userId: locals.user.id,
      ip: getClientAddress(),
    });
    const done = REVIEW_ACTION_DONE[action][result.changed ? 0 : 1];
    if (!ruled.ok) return fail(410, { error: `${done}, but ${ruled.error}`, gone: true });
    return { success: true, serviceReviewAction: done };
  };

/** The offering queue's forms for a report on one of its buyer reviews. */
export const serviceReviewActions = {
  hideServiceReview: reviewAction('hide'),
  restoreServiceReview: reviewAction('restore'),
  holdServiceReview: reviewAction('hold'),
};
