import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_REPORT_REWARD_KEY } from '@civitai/shared/report-reward';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { reportAdminAttentionDetailsSchema } from '~/server/schema/report.schema';
import { LOCK_REVIEW_REPORT_REASON } from '~/shared/constants/lock-review.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    report: { create: (...args: unknown[]) => reportCreate(...args) },
    model: { update: vi.fn() },
  })
);

// Distinct so a value reaching the wrong place cannot pass by colliding with the right one.
const MODEL = 71;
const OWNER = 82;
const STRANGER = 93;
const EXISTING_REPORT = 104;

const reportFindFirst = dbMock.dbWrite.report.findFirst;
const closedRequests = dbMock.dbRead.report.findMany;
const openRequest = dbMock.dbRead.report.findFirst;
const reportUpdate = dbMock.dbWrite.report.update;
const modelFindUnique = dbMock.dbRead.model.findUnique;
const reportCreate = vi.fn();

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');
const { getLockReviewState } = await import('~/server/services/lock-review.service');

const DAY = 24 * 60 * 60 * 1000;
/** Closed requests, filtered by the cutoff the service asks for so the window itself is exercised. */
const closedRequestsAre = (rows: { daysAgo: number; lockedProperties: string[] }[]) =>
  closedRequests.mockImplementation((async (args: { where: { statusSetAt: { gt: Date } } }) =>
    rows
      .map(({ daysAgo, lockedProperties }) => ({
        statusSetAt: new Date(Date.now() - daysAgo * DAY),
        details: { reason: LOCK_REVIEW_REPORT_REASON, lockedProperties },
      }))
      .filter((row) => row.statusSetAt > args.where.statusSetAt.gt)) as never);

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
  closedRequests.mockReset().mockResolvedValue([]);
  openRequest.mockReset().mockResolvedValue(null);
});

describe('a request to review a locked setting', () => {
  it('is refused from anyone but the model owner', async () => {
    await expect(createReport(lockReview(STRANGER))).rejects.toThrow(/Only the model's owner/);
    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).not.toHaveBeenCalled();
  });

  it('is refused from a moderator, even on their own model', async () => {
    await expect(createReport({ ...lockReview(OWNER), isModerator: true })).rejects.toThrow(
      /Moderators can change locked settings directly/
    );
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is refused for a setting that is not locked', async () => {
    await expect(createReport(lockReview(OWNER, ['category']))).rejects.toThrow(
      /can't be reviewed this way/
    );
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is refused for a lock that is not requestable, even alongside one that is', async () => {
    modelFindUnique.mockResolvedValue({ userId: OWNER, lockedProperties: ['nsfw', 'poi'] });

    await expect(createReport(lockReview(OWNER, ['poi']))).rejects.toThrow(
      /can't be reviewed this way/
    );
    await expect(createReport(lockReview(OWNER, ['nsfw', 'poi']))).rejects.toThrow(
      /can't be reviewed this way/
    );
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is refused within 30 days of a request closed with its settings still locked', async () => {
    closedRequestsAre([{ daysAgo: 5, lockedProperties: ['sfwOnly'] }]);

    await expect(createReport(lockReview(OWNER))).rejects.toThrow(/ask again/);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is allowed again once the 30 days are up', async () => {
    closedRequestsAre([{ daysAgo: 31, lockedProperties: ['sfwOnly'] }]);

    await createReport(lockReview(OWNER));
    expect(reportCreate).toHaveBeenCalled();
  });

  it('is allowed again when the closed request led to a lock being lifted', async () => {
    // The earlier request named a setting that is no longer locked.
    closedRequestsAre([{ daysAgo: 5, lockedProperties: ['category'] }]);

    await createReport(lockReview(OWNER));
    expect(reportCreate).toHaveBeenCalled();
  });

  it('is allowed again when only some of the settings it named are still locked', async () => {
    closedRequestsAre([{ daysAgo: 5, lockedProperties: ['nsfw', 'category'] }]);

    await createReport(lockReview(OWNER));
    expect(reportCreate).toHaveBeenCalled();
  });

  it('during a cooldown, still joins a request that is already open', async () => {
    closedRequestsAre([{ daysAgo: 5, lockedProperties: ['sfwOnly'] }]);
    openRequest.mockResolvedValue({ id: EXISTING_REPORT });
    reportFindFirst.mockResolvedValue({
      id: EXISTING_REPORT,
      userId: OWNER,
      alsoReportedBy: [],
      previouslyReviewedCount: 0,
      details: { reason: LOCK_REVIEW_REPORT_REASON, lockedProperties: ['sfwOnly'] },
    });

    await expect(createReport(lockReview(OWNER))).resolves.toBeTruthy();
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is refused when it names no setting', async () => {
    await expect(createReport(lockReview(OWNER, []))).rejects.toThrow(/can't be reviewed this way/);
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
    expect(created.data.details).toMatchObject({
      lockedProperties: ['sfwOnly'],
      violation: `${LOCK_REVIEW_REPORT_REASON}: sfwOnly`,
    });
  });

  it('earns its owner no report reward when actioned', async () => {
    await createReport(lockReview(OWNER));

    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).toMatchObject({ [NO_REPORT_REWARD_KEY]: true });
  });

  it("the owner's second request extends their open one, not as a second reporter", async () => {
    reportFindFirst.mockResolvedValue({
      id: EXISTING_REPORT,
      userId: OWNER,
      alsoReportedBy: [],
      previouslyReviewedCount: 0,
      details: {
        reason: LOCK_REVIEW_REPORT_REASON,
        lockedProperties: ['sfwOnly'],
        comment: 'First reason.',
      },
    });

    await createReport({
      ...lockReview(OWNER, ['nsfw']),
      details: { ...lockReview(OWNER, ['nsfw']).details, comment: 'Second reason.' },
    });

    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).toHaveBeenCalledTimes(1);
    const [{ where, data }] = reportUpdate.mock.calls[0] as [
      { where: MixedObject; data: MixedObject }
    ];
    expect(where).toEqual({ id: EXISTING_REPORT });
    expect(data).not.toHaveProperty('alsoReportedBy');
    expect(data.details).not.toHaveProperty('additionalReports');
    expect(data.details).toMatchObject({
      lockedProperties: ['nsfw', 'sfwOnly'],
      violation: `${LOCK_REVIEW_REPORT_REASON}: nsfw, sfwOnly`,
      comment: 'First reason.\n\nSecond reason.',
    });
  });

  it('control: any other AdminAttention report on a model dedupes as before', async () => {
    await createReport({
      ...lockReview(STRANGER),
      details: { reason: 'Other concern' },
    });

    const [query] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(query.where.status).toBeUndefined();
    expect(query.where.AND).toBeUndefined();
    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).not.toHaveProperty(NO_REPORT_REWARD_KEY);
  });
});

describe('what the owner is offered', () => {
  it('nothing, for someone else', async () => {
    expect(await getLockReviewState({ modelId: MODEL, userId: STRANGER })).toBeNull();
  });

  it('nothing, for a moderator', async () => {
    expect(
      await getLockReviewState({ modelId: MODEL, userId: OWNER, isModerator: true })
    ).toBeNull();
  });

  it('nothing, when the only locks are not requestable', async () => {
    modelFindUnique.mockResolvedValue({ userId: OWNER, lockedProperties: ['poi', 'minor'] });
    expect(await getLockReviewState({ modelId: MODEL, userId: OWNER })).toMatchObject({
      requestable: [],
    });
  });

  it('only the requestable locks, when mixed', async () => {
    modelFindUnique.mockResolvedValue({ userId: OWNER, lockedProperties: ['poi', 'nsfw'] });
    expect(await getLockReviewState({ modelId: MODEL, userId: OWNER })).toMatchObject({
      requestable: ['nsfw'],
      pending: false,
      reopensAt: null,
    });
  });

  it('an open request as pending', async () => {
    openRequest.mockResolvedValue({ id: EXISTING_REPORT });
    expect(await getLockReviewState({ modelId: MODEL, userId: OWNER })).toMatchObject({
      pending: true,
    });
  });

  it('the date it reopens, during a cooldown', async () => {
    closedRequestsAre([{ daysAgo: 10, lockedProperties: ['nsfw'] }]);
    const state = await getLockReviewState({ modelId: MODEL, userId: OWNER });
    const expected = Date.now() + 20 * DAY;
    expect(Math.abs((state?.reopensAt?.getTime() ?? 0) - expected)).toBeLessThan(60_000);
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

  it('refuses a setting that is never requestable', () => {
    expect(
      reportAdminAttentionDetailsSchema.safeParse({
        reason: LOCK_REVIEW_REPORT_REASON,
        lockedProperties: ['poi'],
        comment: 'None of the showcase images are mature.',
      }).success
    ).toBe(false);
  });

  it('control: other reasons need neither', () => {
    expect(reportAdminAttentionDetailsSchema.safeParse({ reason: 'Other concern' }).success).toBe(
      true
    );
  });
});
