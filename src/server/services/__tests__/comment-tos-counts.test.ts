import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * What "Remove as ToS" reports back is the number of rows it actually flagged.
 *
 * Both services loop per id and skip a row whose update threw, so `ids.length` was a count of what was
 * ASKED for. Two consumers read it as a result: the moderator app writes a ModActivity row from it and
 * clears rows off the operator's screen, and `setTosViolationHandler` maps `count === 0` to NOT_FOUND —
 * a branch that is unreachable while the count is the input length.
 */

vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/rewards', () => ({
  reportAcceptedReward: { apply: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));

const { bulkSetCommentV2TosViolation } = await import('../commentsv2.service');
const { bulkSetCommentTosViolation } = await import('../comment.service');

// Distinct from every comment id, so a bound comment id is never the actor's.
const actor = { id: 99 };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
  dbMock.dbWrite.comment.update.mockResolvedValue({ id: 1, user: { id: 9 }, model: null });
  dbMock.dbWrite.commentV2.update.mockResolvedValue({ id: 1, userId: 9 });
});

describe('bulkSetCommentV2TosViolation', () => {
  it('counts rows written, not ids submitted', async () => {
    dbMock.dbWrite.commentV2.update
      .mockRejectedValueOnce(new Error('no such row'))
      .mockResolvedValueOnce({ id: 2, userId: 9 });

    await expect(bulkSetCommentV2TosViolation({ ids: [1, 2], actor })).resolves.toMatchObject({
      count: 1,
    });
  });

  it('reports zero when nothing was flagged, which is what the NOT_FOUND branch reads', async () => {
    dbMock.dbWrite.commentV2.update.mockRejectedValue(new Error('no such row'));

    await expect(bulkSetCommentV2TosViolation({ ids: [1, 2], actor })).resolves.toMatchObject({
      count: 0,
    });
  });
});

// A comment already hidden may be one its author deleted, kept for a hold: its reports are still
// actioned, but its author must not hear about a comment they removed.
it('bulkSetCommentV2TosViolation actions an already-hidden comment without telling its author', async () => {
  const { createNotification } = await import('~/server/services/notification.service');
  vi.mocked(createNotification).mockClear();
  dbMock.dbWrite.commentV2.findUnique.mockResolvedValueOnce({ tosViolation: true } as never);
  dbMock.dbWrite.commentV2.findUnique.mockResolvedValueOnce({ tosViolation: false } as never);

  await expect(bulkSetCommentV2TosViolation({ ids: [1, 2], actor })).resolves.toMatchObject({
    count: 2,
    notified: 1,
  });
  expect(createNotification).toHaveBeenCalledTimes(1);
  const actionedIds = dbMock.dbWrite.$queryRaw.mock.calls.map((call) => call.slice(1));
  expect(actionedIds.some((values) => values.includes(1))).toBe(true);
  expect(dbMock.dbWrite.commentV2.update).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 1 } })
  );
});

// The legacy twin: an author's own delete keeps a legacy comment hidden for a hold the same way.
it('bulkSetCommentTosViolation actions and rewards an already-hidden comment without telling its author', async () => {
  const { createNotification } = await import('~/server/services/notification.service');
  const { reportAcceptedReward } = await import('~/server/rewards');
  dbMock.dbWrite.comment.findUnique.mockResolvedValueOnce({ tosViolation: true } as never);
  dbMock.dbWrite.comment.findUnique.mockResolvedValueOnce({ tosViolation: false } as never);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (_s: unknown, ...values: unknown[]) =>
    values.includes(1) ? [{ id: 501, userId: 7 }] : []) as never);

  await expect(bulkSetCommentTosViolation({ ids: [1, 2], actor })).resolves.toMatchObject({
    count: 2,
    notified: 1,
    rewardedReports: 1,
  });
  expect(createNotification).toHaveBeenCalledTimes(1);
  expect(reportAcceptedReward.apply).toHaveBeenCalledWith(
    { userId: 7, reportId: 501 },
    expect.anything()
  );
});

describe('bulkSetCommentTosViolation', () => {
  it('counts rows written, not ids submitted', async () => {
    dbMock.dbWrite.comment.update
      .mockRejectedValueOnce(new Error('no such row'))
      .mockResolvedValueOnce({ id: 2, user: { id: 9 }, model: null });

    await expect(bulkSetCommentTosViolation({ ids: [1, 2], actor })).resolves.toMatchObject({
      count: 1,
    });
  });
});
