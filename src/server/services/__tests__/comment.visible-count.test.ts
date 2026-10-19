import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { hidden, blockedBy, blocked } = vi.hoisted(() => ({
  hidden: vi.fn(async (): Promise<{ id: number }[]> => []),
  blockedBy: vi.fn(async (): Promise<{ id: number }[]> => []),
  blocked: vi.fn(async (): Promise<{ id: number }[]> => []),
}));

vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenUsers: { getCached: hidden },
  BlockedByUsers: { getCached: blockedBy },
  BlockedUsers: { getCached: blocked },
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: async () => dbMock.dbRead,
  preventReplicationLag: vi.fn(),
}));

const { getVisibleCommentCount, getComments, getPinnedComments } = await import(
  '../comment.service'
);

const MODEL_ID = 10;
const user = (isModerator = false) => ({ id: 42, isModerator } as never);

const countWheres = () => dbMock.dbRead.comment.count.mock.calls.map(([arg]) => arg.where);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.comment.count.mockReset();
  dbMock.dbRead.comment.findMany.mockReset();
  dbMock.dbRead.model.findUnique.mockReset();
  hidden.mockResolvedValue([]);
  blockedBy.mockResolvedValue([]);
  blocked.mockResolvedValue([]);
});

describe('getVisibleCommentCount', () => {
  it('sums unpinned and pinned top-level comments the viewer can see', async () => {
    dbMock.dbRead.comment.count.mockResolvedValueOnce(20).mockResolvedValueOnce(3);

    await expect(
      getVisibleCommentCount({ input: { modelId: MODEL_ID }, user: user() })
    ).resolves.toBe(23);

    const [unpinned, pinned] = countWheres();
    expect(unpinned).toMatchObject({ pinnedAt: null });
    expect(pinned).toMatchObject({ pinnedAt: { not: null } });
  });

  it('applies the same filters as the list for a non-moderator with excluded users', async () => {
    hidden.mockResolvedValue([{ id: 1 }]);
    blocked.mockResolvedValue([{ id: 2 }]);
    dbMock.dbRead.comment.findMany.mockResolvedValue([]);

    await getVisibleCommentCount({ input: { modelId: MODEL_ID }, user: user() });
    await getComments({ input: { modelId: MODEL_ID }, select: {}, user: user() });
    await getPinnedComments({ input: { modelId: MODEL_ID }, select: {}, user: user() });

    const [countUnpinned, countPinned] = countWheres();
    const [listWhere, pinnedWhere] = dbMock.dbRead.comment.findMany.mock.calls.map(
      ([arg]) => arg.where
    );
    expect(countUnpinned).toEqual(listWhere);
    expect(countPinned).toEqual(pinnedWhere);
    expect(countUnpinned).toEqual({
      modelId: MODEL_ID,
      userId: { notIn: [1, 2] },
      parentId: { equals: null },
      tosViolation: false,
      hidden: false,
      pinnedAt: null,
    });
  });

  it('does not filter tosViolation for moderators and honours the hidden flag', async () => {
    await getVisibleCommentCount({ input: { modelId: MODEL_ID, hidden: true }, user: user(true) });

    // Hidden replies render in their thread, not in the "See N hidden comments" modal, so the
    // hidden count must stay top-level too.
    for (const where of countWheres()) {
      expect(where.tosViolation).toBeUndefined();
      expect(where.hidden).toBe(true);
      expect(where.parentId).toEqual({ equals: null });
    }
  });

  it('keeps blocked-by users excluded from the pinned count even for the model owner, like the pinned list', async () => {
    blockedBy.mockResolvedValue([{ id: 9 }]);
    dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: 42 });

    await getVisibleCommentCount({ input: { modelId: MODEL_ID }, user: user() });

    const [unpinned, pinned] = countWheres();
    expect(unpinned.userId).toBeUndefined();
    expect(pinned.userId).toEqual({ notIn: [9] });
  });
});
