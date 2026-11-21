import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINOR_SEXUALIZATION_VIOLATION } from '@civitai/shared/post-text-report';

/**
 * The offering queue's review actions: a CSAM or minor-sexualization report is held (a text for the
 * CSAM queue, and the review taken down) and never answered with a plain hide; the review acted on is
 * the one the report names; and the ruling each leaves on the report.
 */

const setReportStatus = vi.fn();
vi.mock('$lib/server/reports.service', () => ({ setReportStatus }));
const getReportServiceReview = vi.fn();
const moderateServiceReview = vi.fn();
vi.mock('$lib/server/service-review-reports.service', () => ({
  getReportServiceReview,
  moderateServiceReview,
}));
const canAccess = vi.fn(() => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { serviceReviewActions } = await import('../service-review-actions.server');

const REVIEW = 990000071;
const REPORT = 990000200;
const run = (
  name: keyof typeof serviceReviewActions,
  fields: Record<string, string> = { id: String(REPORT) },
  slug = 'service'
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return serviceReviewActions[name]({
    request: new Request('https://x.test/reports/service', { method: 'POST', body: form }),
    locals: { user: { id: 4, username: 'mod' }, grants: {} },
    params: { slug },
    getClientAddress: () => '127.0.0.1',
  } as never);
};
const tos = { reason: 'TOSViolation', details: { violation: 'Spam' } };
const minors = { reason: 'TOSViolation', details: { violation: MINOR_SEXUALIZATION_VIOLATION } };

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockReturnValue(true);
  getReportServiceReview.mockResolvedValue({ reviewId: REVIEW, hasText: true, ...tos });
  moderateServiceReview.mockResolvedValue({ ok: true, changed: true });
  setReportStatus.mockResolvedValue({ ok: true, changed: true });
});

describe('hiding a reported review', () => {
  it('hides the review the report names, then actions the report', async () => {
    expect(await run('hideServiceReview', { id: String(REPORT), reviewId: '999' })).toEqual({
      success: true,
      serviceReviewAction: 'Review hidden',
    });
    expect(moderateServiceReview).toHaveBeenCalledWith({
      reviewId: REVIEW,
      action: 'hide',
      text: undefined,
      reportId: REPORT,
    });
    expect(setReportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: REPORT, status: 'Actioned', userId: 4 })
    );
  });

  it('is refused for a minor-sexualization or CSAM report, which go to the CSAM queue', async () => {
    for (const report of [minors, { reason: 'CSAM', details: {} }]) {
      getReportServiceReview.mockResolvedValueOnce({ reviewId: REVIEW, hasText: true, ...report });
      expect(await run('hideServiceReview')).toMatchObject({ status: 400 });
    }
    expect(moderateServiceReview).not.toHaveBeenCalled();
    expect(setReportStatus).not.toHaveBeenCalled();
  });

  it('is refused outside the offering queue, or without it', async () => {
    expect(await run('hideServiceReview', { id: String(REPORT) }, 'post')).toMatchObject({
      status: 403,
    });
    canAccess.mockReturnValueOnce(false);
    expect(await run('hideServiceReview')).toMatchObject({ status: 403 });
    expect(moderateServiceReview).not.toHaveBeenCalled();
  });

  it('leaves the report alone when the main app refuses, or the report is not on a review', async () => {
    moderateServiceReview.mockResolvedValueOnce({ ok: false, error: 'nope' });
    expect(await run('hideServiceReview')).toMatchObject({ status: 409, data: { error: 'nope' } });
    getReportServiceReview.mockResolvedValueOnce(null);
    expect(await run('hideServiceReview')).toMatchObject({ status: 410 });
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});

describe('holding a reported review text for CSAM review', () => {
  it('holds the chosen text of a minor-sexualization report and actions it', async () => {
    getReportServiceReview.mockResolvedValueOnce({ reviewId: REVIEW, hasText: true, ...minors });
    expect(await run('holdServiceReview', { id: String(REPORT), text: 'reply' })).toEqual({
      success: true,
      serviceReviewAction: 'Held for CSAM review',
    });
    expect(moderateServiceReview).toHaveBeenCalledWith({
      reviewId: REVIEW,
      action: 'hold',
      text: 'reply',
      reportId: REPORT,
    });
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'Actioned' }));
  });

  it('holds a review with no text by taking it down, with no text named', async () => {
    getReportServiceReview.mockResolvedValueOnce({ reviewId: REVIEW, hasText: false, ...minors });
    expect(await run('holdServiceReview')).toEqual({
      success: true,
      serviceReviewAction: 'Held for CSAM review',
    });
    expect(moderateServiceReview).toHaveBeenCalledWith({
      reviewId: REVIEW,
      action: 'hold',
      text: undefined,
      reportId: REPORT,
    });
  });

  it('is refused for an ordinary report, or without a text the review has', async () => {
    expect(await run('holdServiceReview', { id: String(REPORT), text: 'comment' })).toMatchObject({
      status: 400,
    });
    getReportServiceReview.mockResolvedValueOnce({ reviewId: REVIEW, hasText: true, ...minors });
    expect(await run('holdServiceReview')).toMatchObject({ status: 400 });
    expect(moderateServiceReview).not.toHaveBeenCalled();
  });
});

describe('restoring a hidden review', () => {
  it('restores and dismisses the report', async () => {
    expect(await run('restoreServiceReview')).toEqual({
      success: true,
      serviceReviewAction: 'Review restored',
    });
    expect(setReportStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'Unactioned' }));
  });

  it('leaves the report as it is when there was nothing to restore', async () => {
    moderateServiceReview.mockResolvedValueOnce({ ok: true, changed: false });
    expect(await run('restoreServiceReview')).toEqual({
      success: true,
      serviceReviewAction: 'Not hidden by a moderator',
    });
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});
