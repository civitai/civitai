import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    report: { create: (...args: unknown[]) => reportCreate(...args) },
    image: { update: vi.fn(), findUnique: vi.fn(async () => null) },
    model: { update: vi.fn() },
  })
);

/**
 * The guard is User-only on purpose, so the tests that matter most here are the
 * ones that prove the OTHER entity types were left alone: reporting your own
 * image or model is how a creator contests a rating, and a fix that closed the
 * self-profile hole by closing that too would look identical from the User
 * tests alone.
 */
const REPORTER = 41;
const OTHER_USER = 52;
const OWN_IMAGE = 63;
const SYSTEM_USER = -1;

const reportFindFirst = dbMock.dbWrite.report.findFirst;
const reportCreate = vi.fn();
const reportUpdate = dbMock.dbWrite.report.update;

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

beforeEach(() => {
  vi.clearAllMocks();
  // No existing report to fold into, so every allowed case below reaches the
  // write and `create` is a meaningful assertion.
  reportFindFirst.mockResolvedValue(null);
  reportCreate.mockResolvedValue({ id: 74, details: {} });
});

describe('a user cannot report their own profile', () => {
  it('refuses the self-profile report before anything is written', async () => {
    await expect(
      createReport({
        userId: REPORTER,
        id: REPORTER,
        type: ReportEntity.User,
        reason: ReportReason.AdminAttention,
        details: { comment: 'please look at my account' },
      })
    ).rejects.toThrow(/your own profile/);

    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).not.toHaveBeenCalled();
    // The dedupe read must not run either — a refusal that still queries has
    // moved the guard below the work it exists to skip.
    expect(reportFindFirst).not.toHaveBeenCalled();
  });

  it('names a route that reaches a human', async () => {
    // AdminAttention is the top reason people picked this for, so the refusal
    // has to replace the dead end rather than just close it.
    await expect(
      createReport({
        userId: REPORTER,
        id: REPORTER,
        type: ReportEntity.User,
        reason: ReportReason.AdminAttention,
        details: {},
      })
    ).rejects.toThrow(/support-portal/i);
  });

  it('refuses regardless of reason', async () => {
    await expect(
      createReport({
        userId: REPORTER,
        id: REPORTER,
        type: ReportEntity.User,
        reason: ReportReason.TOSViolation,
        details: { violation: 'whatever' },
      })
    ).rejects.toThrow(/your own profile/);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('still reports someone else’s profile', async () => {
    await createReport({
      userId: REPORTER,
      id: OTHER_USER,
      type: ReportEntity.User,
      reason: ReportReason.AdminAttention,
      details: { comment: 'impersonating me' },
    });

    expect(reportCreate).toHaveBeenCalledOnce();
  });

  it('still lets the automated moderation pass file a profile report', async () => {
    // entity-moderation files these as the system user against a real user id,
    // so the two are never equal — pinned because a guard written as "reporter
    // is a party to this" rather than "reporter IS the target" would kill it.
    await createReport({
      userId: SYSTEM_USER,
      id: OTHER_USER,
      type: ReportEntity.User,
      isModerator: true,
      reason: ReportReason.Automated,
      details: { tags: ['whatever'] },
    });

    expect(reportCreate).toHaveBeenCalledOnce();
  });
});

describe('reporting your own CONTENT is untouched', () => {
  it('still files a report on your own image', async () => {
    // This is how a creator contests a rating or a flag. Losing it is the one
    // way this fix could do real damage.
    await createReport({
      userId: REPORTER,
      id: OWN_IMAGE,
      type: ReportEntity.Image,
      reason: ReportReason.AdminAttention,
      details: { comment: 'this was rated wrong' },
    });

    expect(reportCreate).toHaveBeenCalledOnce();
  });

  it('still files a report on a model whose id collides with the reporter’s user id', async () => {
    // `id` is deliberately equal to `userId` here: the guard compares two ids
    // drawn from different tables, so it has to be gated on the entity type as
    // well. Without that gate this exact call is refused and model 41 becomes
    // unreportable by user 41.
    await createReport({
      userId: REPORTER,
      id: REPORTER,
      type: ReportEntity.Model,
      reason: ReportReason.AdminAttention,
      details: { comment: 'this was flagged wrong' },
    });

    expect(reportCreate).toHaveBeenCalledOnce();
  });
});
