import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * What "Remove as ToS" reports back is the number of rows it actually flagged.
 *
 * The service loops per id and skips a row whose update threw, so `ids.length` was a count of what was
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

// Distinct from every comment id, so a bound comment id is never the actor's.
const actor = { id: 99 };

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
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

// A comment already hidden for ToS still has its reports actioned, but its author is not told again.
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
