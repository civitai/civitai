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
const primaryModelFindUnique = dbMock.dbWrite.model.findUnique;
const primaryClosedRequests = dbMock.dbWrite.report.findMany;
const reportUpdate = dbMock.dbWrite.report.update;
const reportUpdateMany = dbMock.dbWrite.report.updateMany;
const modelFindUnique = dbMock.dbRead.model.findUnique;
const reportCreate = vi.fn();

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');
const { getLockReviewState } = await import('~/server/services/lock-review.service');
const { POI_LOCKED_PROPERTIES } = await import(
  '~/server/services/text-scan/actions/model-poi-minor'
);
const { MINOR_LOCKED_PROPERTIES } = await import('~/server/services/model.service');

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
  reportUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  modelFindUnique.mockResolvedValue({ userId: OWNER, lockedProperties: ['nsfw', 'sfwOnly'] });
  closedRequests.mockReset().mockResolvedValue([]);
  openRequest.mockReset().mockResolvedValue(null);
  reportFindFirst.mockReset().mockResolvedValue(null);
  primaryModelFindUnique
    .mockReset()
    .mockResolvedValue({ userId: OWNER, lockedProperties: ['nsfw', 'sfwOnly'] });
  primaryClosedRequests.mockReset().mockResolvedValue([]);
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

  it.each([
    ['real person', () => POI_LOCKED_PROPERTIES],
    ['minor', () => MINOR_LOCKED_PROPERTIES],
  ])(
    'is refused on a model flagged as a %s, for the settings that flag locked',
    async (_, locks) => {
      modelFindUnique.mockResolvedValue({ userId: OWNER, lockedProperties: [...locks()] });

      await expect(createReport(lockReview(OWNER, ['nsfw']))).rejects.toThrow(
        /can't be reviewed this way/
      );
      await expect(createReport(lockReview(OWNER, ['sfwOnly']))).rejects.toThrow(
        /can't be reviewed this way/
      );
      expect(reportCreate).not.toHaveBeenCalled();
    }
  );

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
      violation: `${LOCK_REVIEW_REPORT_REASON}: Cannot be used for NSFW generation`,
    });
  });

  it('earns its owner no report reward when actioned', async () => {
    await createReport(lockReview(OWNER));

    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).toMatchObject({ [NO_REPORT_REWARD_KEY]: true });
  });

  const ownOpenRequest = (details: MixedObject) =>
    reportFindFirst.mockResolvedValue({
      id: EXISTING_REPORT,
      userId: OWNER,
      alsoReportedBy: [],
      previouslyReviewedCount: 0,
      details: { reason: LOCK_REVIEW_REPORT_REASON, ...details },
    });
  const askAgain = (lockedProperties: string[], comment: string) =>
    createReport({
      ...lockReview(OWNER, lockedProperties),
      details: { ...lockReview(OWNER, lockedProperties).details, comment },
    });
  const mergeWrite = () => {
    const [{ where, data }] = reportUpdateMany.mock.calls[0] as [
      { where: MixedObject; data: MixedObject }
    ];
    return { where, data, details: data.details as MixedObject };
  };

  it("the owner's second request extends their open one, not as a second reporter", async () => {
    ownOpenRequest({ lockedProperties: ['sfwOnly'], comment: 'First reason.' });

    await askAgain(['nsfw'], 'Second reason.');

    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).not.toHaveBeenCalled();
    expect(reportUpdateMany).toHaveBeenCalledTimes(1);
    const { where, data, details } = mergeWrite();
    expect(where).toEqual({ id: EXISTING_REPORT, status: 'Pending' });
    expect(data).not.toHaveProperty('alsoReportedBy');
    expect(details).not.toHaveProperty('additionalReports');
    expect(details).toMatchObject({
      lockedProperties: ['nsfw', 'sfwOnly'],
      violation: `${LOCK_REVIEW_REPORT_REASON}: Is intended to produce mature themes, Cannot be used for NSFW generation`,
      comment: 'First reason.\n\n---\n\nSecond reason.',
    });
  });

  it('files a new request when the open one was closed before the merge landed', async () => {
    ownOpenRequest({ lockedProperties: ['sfwOnly'], comment: 'First reason.' });
    reportUpdateMany.mockResolvedValue({ count: 0 });

    await askAgain(['nsfw'], 'Second reason.');

    expect(reportCreate).toHaveBeenCalledTimes(1);
    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).toMatchObject({
      lockedProperties: ['nsfw'],
      comment: 'Second reason.',
    });
  });

  it('keeps a reason with several paragraphs whole across asks', async () => {
    ownOpenRequest({
      lockedProperties: ['sfwOnly'],
      comments: ['A\n\nB\n\nC\n\nD'],
      comment: 'A\n\nB\n\nC\n\nD',
    });

    await askAgain(['sfwOnly'], 'X\n\nThanks.');

    expect(mergeWrite().details).toMatchObject({
      comments: ['A\n\nB\n\nC\n\nD', 'X\n\nThanks.'],
      comment: 'A\n\nB\n\nC\n\nD\n\n---\n\nX\n\nThanks.',
    });
  });

  it('drops the oldest whole ask once there are more than three', async () => {
    ownOpenRequest({
      lockedProperties: ['sfwOnly'],
      comments: ['One\n\nmore.', 'Two\n\nmore.', 'Three\n\nmore.'],
    });

    await askAgain(['sfwOnly'], 'Four\n\nmore.');

    expect(mergeWrite().details.comments).toEqual([
      'Two\n\nmore.',
      'Three\n\nmore.',
      'Four\n\nmore.',
    ]);
  });

  it('moves a repeated reason to its latest position instead of keeping it twice', async () => {
    ownOpenRequest({ lockedProperties: ['sfwOnly'], comments: ['Same reason.', 'Other reason.'] });

    await askAgain(['sfwOnly'], 'Same reason.');

    expect(mergeWrite().details.comments).toEqual(['Other reason.', 'Same reason.']);
  });

  it('reads a request filed with only a comment as one ask', async () => {
    ownOpenRequest({ lockedProperties: ['sfwOnly'], comment: 'Legacy\n\nreason.' });

    await askAgain(['sfwOnly'], 'New reason.');

    expect(mergeWrite().details.comments).toEqual(['Legacy\n\nreason.', 'New reason.']);
  });

  it('records the reason of a first ask as its own entry', async () => {
    await createReport(lockReview(OWNER));

    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).toMatchObject({
      comments: ['None of the showcase images are mature.'],
    });
  });

  it('holds the request it falls through to to the cooldown the close began', async () => {
    reportUpdateMany.mockResolvedValue({ count: 0 });
    // The replica has not seen the close: it still reads the request as open, and nothing closed.
    openRequest.mockResolvedValue({ id: EXISTING_REPORT });
    // The primary has: the request is closed today with its setting still locked.
    primaryModelFindUnique.mockResolvedValue({
      userId: OWNER,
      lockedProperties: ['nsfw', 'sfwOnly'],
    });
    reportFindFirst.mockImplementation((async (args: { where: MixedObject }) =>
      args.where.details
        ? null
        : {
            id: EXISTING_REPORT,
            userId: OWNER,
            alsoReportedBy: [],
            previouslyReviewedCount: 0,
            details: { reason: LOCK_REVIEW_REPORT_REASON, lockedProperties: ['sfwOnly'] },
          }) as never);
    primaryClosedRequests.mockResolvedValue([
      {
        statusSetAt: new Date(),
        details: { reason: LOCK_REVIEW_REPORT_REASON, lockedProperties: ['sfwOnly'] },
      },
    ] as never);

    await expect(askAgain(['nsfw'], 'Second reason.')).rejects.toThrow(/ask again/);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('never carries a setting that cannot be requested into the merged request', async () => {
    ownOpenRequest({ lockedProperties: ['poi', 'sfwOnly', 'minor'] });

    await askAgain(['nsfw'], 'Second reason.');

    expect(mergeWrite().details.lockedProperties).toEqual(['nsfw', 'sfwOnly']);
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

  it.each([
    ['real person', () => POI_LOCKED_PROPERTIES],
    ['minor', () => MINOR_LOCKED_PROPERTIES],
  ])(
    'nothing, for a model flagged as a %s, whose flag also locks other settings',
    async (_, locks) => {
      expect(locks()).toEqual(expect.arrayContaining(['nsfw', 'sfwOnly']));
      modelFindUnique.mockResolvedValue({
        userId: OWNER,
        lockedProperties: [...locks(), 'category'],
      });
      expect(await getLockReviewState({ modelId: MODEL, userId: OWNER })).toMatchObject({
        requestable: [],
      });
    }
  );

  it('every requestable lock, in display order, when none blocks the request', async () => {
    modelFindUnique.mockResolvedValue({ userId: OWNER, lockedProperties: ['category', 'nsfw'] });
    expect(await getLockReviewState({ modelId: MODEL, userId: OWNER })).toMatchObject({
      requestable: ['nsfw', 'category'],
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
