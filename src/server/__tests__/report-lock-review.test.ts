import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { reportAdminAttentionDetailsSchema } from '~/server/schema/report.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    report: { create: (...args: unknown[]) => reportCreate(...args) },
    model: { update: vi.fn() },
  })
);

// TODO(build): import from the shared constant once it exists; the wording awaits review.
const LOCK_REVIEW_REPORT_REASON = 'Owner requests review of a locked setting';

// Distinct so a value reaching the wrong place cannot pass by colliding with the right one.
const MODEL = 71;
const OWNER = 82;
const STRANGER = 93;
const EXISTING_REPORT = 104;

const reportFindFirst = dbMock.dbWrite.report.findFirst;
const reportUpdate = dbMock.dbWrite.report.update;
const modelFindUnique = dbMock.dbRead.model.findUnique;
const reportCreate = vi.fn();

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

const lockReview = (userId: number, lockedProperties: string[] = ['sfwOnly']) => ({
  userId,
  id: MODEL,
  type: ReportEntity.Model,
  reason: ReportReason.AdminAttention,
  details: {
    reason: LOCK_REVIEW_REPORT_REASON,
    lockedProperties,
    comment: 'None of the showcase images are mature.',
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 137, details: {} });
  reportUpdate.mockResolvedValue({ id: EXISTING_REPORT });
  modelFindUnique.mockResolvedValue({ userId: OWNER, lockedProperties: ['nsfw', 'sfwOnly'] });
});

describe('a request to review a locked setting', () => {
  it('is refused from anyone but the model owner', async () => {
    await expect(createReport(lockReview(STRANGER))).rejects.toThrow();
    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).not.toHaveBeenCalled();
  });

  it('is refused for a setting that is not locked', async () => {
    await expect(createReport(lockReview(OWNER, ['category']))).rejects.toThrow();
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is refused when it names no setting', async () => {
    await expect(createReport(lockReview(OWNER, []))).rejects.toThrow();
    expect(reportCreate).not.toHaveBeenCalled();
  });

  /**
   * The plain AdminAttention dedupe matches any earlier report on the model, whatever its status.
   * A request folded into a closed report is never seen; one folded into an open report about
   * something else is shown to a moderator as a second voice on that report.
   */
  it('joins only an open request of its own kind', async () => {
    await createReport(lockReview(OWNER));

    const [query] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(query.where.status).toBe('Pending');
    expect(query.where.AND).toContainEqual({
      details: { path: ['reason'], equals: LOCK_REVIEW_REPORT_REASON },
    });
    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).toMatchObject({ lockedProperties: ['sfwOnly'] });
  });

  it('a second request while one is open returns the open one', async () => {
    reportFindFirst.mockResolvedValue({
      id: EXISTING_REPORT,
      alsoReportedBy: [],
      previouslyReviewedCount: 0,
      details: {},
      userId: OWNER,
    });

    await createReport(lockReview(OWNER));

    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('control: any other AdminAttention report on a model dedupes as before', async () => {
    await createReport({
      ...lockReview(STRANGER),
      details: { reason: 'Other concern' },
    });

    const [query] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(query.where.status).toBeUndefined();
    expect(query.where.AND).toBeUndefined();
    expect(reportCreate).toHaveBeenCalled();
  });
});

describe('the AdminAttention details schema, for a lock review', () => {
  it('keeps the settings named', () => {
    expect(
      reportAdminAttentionDetailsSchema.parse({
        reason: LOCK_REVIEW_REPORT_REASON,
        lockedProperties: ['nsfw'],
        comment: 'None of the showcase images are mature.',
      })
    ).toMatchObject({ lockedProperties: ['nsfw'] });
  });

  it('requires a setting and a reason', () => {
    expect(
      reportAdminAttentionDetailsSchema.safeParse({
        reason: LOCK_REVIEW_REPORT_REASON,
        lockedProperties: [],
        comment: 'None of the showcase images are mature.',
      }).success
    ).toBe(false);
    expect(
      reportAdminAttentionDetailsSchema.safeParse({
        reason: LOCK_REVIEW_REPORT_REASON,
        lockedProperties: ['nsfw'],
      }).success
    ).toBe(false);
  });

  it('control: other reasons need neither', () => {
    expect(reportAdminAttentionDetailsSchema.safeParse({ reason: 'Other concern' }).success).toBe(
      true
    );
  });
});
