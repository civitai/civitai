import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as MessagePatternService from '~/server/services/message-pattern.service';

/**
 * What "Remove as ToS" reports back is the number of rows it actually flagged.
 *
 * Both services loop per id and skip a row whose update threw, so `ids.length` was a count of what was
 * ASKED for. Two consumers read it as a result: the moderator app writes a ModActivity row from it and
 * clears rows off the operator's screen, and `setTosViolationHandler` maps `count === 0` to NOT_FOUND —
 * a branch that is unreachable while the count is the input length.
 */

vi.mock('~/server/services/message-pattern.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MessagePatternService>()),
  reportBlockedMessagePattern: vi.fn(async () => undefined),
}));
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

const actor = { id: 1 };

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
