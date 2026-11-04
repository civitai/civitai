import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Reactions on a comment of a CommentV3-write surface go to CommentV3Reaction, whose trigger keeps
// the comment's reaction count.

const blockCheck = vi.hoisted(() => vi.fn(async (_: unknown) => undefined));
vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => dbMock.dbRead }));
vi.mock('~/server/services/block-check.service', () => ({
  throwIfBlockedByEntityOwner: blockCheck,
}));

const { toggleReaction } = await import('~/server/services/reaction.service');

const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');
const react = (entityId: number) =>
  toggleReaction({ entityType: 'comment', entityId, userId: 5, reaction: 'Like' });
const comment = (row: { entityType: string; deletedAt: Date | null } | undefined) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValueOnce(row ? [row] : []);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleReaction on a CommentV3 comment', () => {
  it('adds the reaction to CommentV3Reaction after the block check, and never to CommentV2', async () => {
    comment({ entityType: 'article', deletedAt: null });
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    expect(await react(1)).toBe('created');
    const [remove, insert] = dbMock.dbWrite.$executeRaw.mock.calls;
    expect(sqlOf(remove)).toMatch(
      /DELETE FROM "CommentV3Reaction"\s+WHERE "commentId" = \? AND "userId" = \? AND reaction = \?/
    );
    expect(remove.slice(1)).toEqual([1, 5, 'Like']);
    expect(sqlOf(insert)).toContain(
      'INSERT INTO "CommentV3Reaction" ("commentId", "userId", reaction)'
    );
    expect(sqlOf(insert)).toMatch(/WHERE c\.id = \? AND c\."deletedAt" IS NULL\s+FOR KEY SHARE/);
    expect(sqlOf(insert)).toContain('ON CONFLICT ("commentId", "userId", reaction) DO NOTHING');
    expect(insert.slice(1)).toEqual([5, 'Like', 1]);
    expect(blockCheck).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, entityType: 'comment', entityId: 1 })
    );
    expect(blockCheck.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[1]
    );
    expect(dbMock.dbWrite.commentV2Reaction.create).not.toHaveBeenCalled();
  });

  it('removes a reaction the user holds, without a block check', async () => {
    comment({ entityType: 'article', deletedAt: null });
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(1);

    expect(await react(1)).toBe('removed');
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(blockCheck).not.toHaveBeenCalled();
  });

  it('adds nothing when the block check refuses', async () => {
    comment({ entityType: 'article', deletedAt: null });
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0);
    blockCheck.mockRejectedValueOnce(new Error('blocked'));
    await expect(react(1)).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a reaction on a deleted comment', async () => {
    comment({ entityType: 'article', deletedAt: new Date() });
    await expect(react(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('is a no-op when the same reaction lands concurrently on a live comment', async () => {
    comment({ entityType: 'article', deletedAt: null });
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    comment({ entityType: 'article', deletedAt: null });
    expect(await react(1)).toBe('noop');
  });

  it('refuses when the comment is deleted between the check and the insert', async () => {
    comment({ entityType: 'article', deletedAt: null });
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    comment({ entityType: 'article', deletedAt: new Date() });
    await expect(react(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    comment({ entityType: 'article', deletedAt: null });
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    comment(undefined);
    await expect(react(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('leaves a comment on any other surface on the CommentV2 table', async () => {
    comment({ entityType: 'image', deletedAt: null });
    expect(await react(2)).toBe('created');
    expect(dbMock.dbWrite.commentV2Reaction.create).toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
