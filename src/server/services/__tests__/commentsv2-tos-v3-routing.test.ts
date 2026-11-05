import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A moderator's ToS removal or restore arrives as CommentV2 ids, mixed across surfaces. The ids on a
// surface that writes CommentV3 go to the CommentV3 action; the rest stay on CommentV2, and the
// counts the moderator sees cover both.

const m = vi.hoisted(() => ({
  v3Ids: vi.fn(),
  setV3: vi.fn(),
  clearV3: vi.fn(),
  reward: vi.fn(async (..._: unknown[]) => undefined),
  notify: vi.fn(async (..._: unknown[]) => undefined),
}));

vi.mock('~/server/services/commentv3/moderation.service', () => ({
  v3WriteCommentIds: m.v3Ids,
  bulkSetCommentV3TosViolation: m.setV3,
  bulkClearCommentV3TosViolation: m.clearV3,
}));
vi.mock('~/server/rewards', () => ({ reportAcceptedReward: { apply: m.reward } }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: m.notify }));

const { bulkSetCommentV2TosViolation, bulkClearCommentV2TosViolation } = await import(
  '~/server/services/commentsv2.service'
);

const V3_ID = 5;
const V2_ID = 7;

beforeEach(() => {
  vi.clearAllMocks();
  m.v3Ids.mockResolvedValue([V3_ID]);
  dbMock.dbWrite.commentV2.update.mockResolvedValue({ id: V2_ID, userId: 70 });
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 900, userId: 80 }]);
});

describe('removing comments as ToS violations', () => {
  it('flags the CommentV3 ids there and the others on CommentV2, and sums the counts', async () => {
    m.setV3.mockResolvedValue({ count: 1, notified: 1, rewardedReports: 2 });
    const actor = { id: 1 };

    await expect(bulkSetCommentV2TosViolation({ ids: [V3_ID, V2_ID], actor })).resolves.toEqual({
      count: 2,
      notified: 2,
      rewardedReports: 3,
    });
    expect(m.setV3).toHaveBeenCalledWith({ ids: [V3_ID], actor });
    expect(dbMock.dbWrite.commentV2.update).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.commentV2.update.mock.calls[0][0]).toMatchObject({
      where: { id: V2_ID },
    });
  });
});

describe('restoring comments removed as ToS violations', () => {
  it('restores the CommentV3 ids there and the others on CommentV2, and sums the counts', async () => {
    m.clearV3.mockResolvedValue({ count: 1, reopenedReports: 2, retainedHidden: 1, failed: 0 });
    // The CommentV2 clear: one comment cleared, one report reopened.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { userId: 70, held: false, cleared: true, reopened: 1 },
    ]);

    await expect(bulkClearCommentV2TosViolation({ ids: [V3_ID, V2_ID] })).resolves.toEqual({
      count: 2,
      reopenedReports: 3,
      retainedHidden: 1,
      failed: 0,
    });
    expect(m.clearV3).toHaveBeenCalledWith({ ids: [V3_ID] });
    const clears = dbMock.dbWrite.$queryRaw.mock.calls.filter(([strings]) =>
      (strings as unknown as string[]).join('?').includes('"tosViolation" = false')
    );
    expect(clears).toHaveLength(1);
    expect(clears[0].slice(1)).toContain(V2_ID);
    expect(clears[0].slice(1)).not.toContain(V3_ID);
  });
});
