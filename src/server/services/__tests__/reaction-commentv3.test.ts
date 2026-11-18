import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Every comment reaction goes to CommentV3Reaction, whose trigger keeps the comment's reaction count.

const blockCheck = vi.hoisted(() => vi.fn(async (_: unknown) => undefined));
vi.mock('~/server/db/db-lag-helpers', () => ({ getDbWithoutLag: async () => dbMock.dbRead }));
vi.mock('~/server/services/block-check.service', () => ({
  throwIfBlockedByEntityOwner: blockCheck,
}));

const { toggleReaction } = await import('~/server/services/reaction.service');

const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');
const react = (entityId: number) =>
  toggleReaction({ entityType: 'comment', entityId, userId: 5, reaction: 'Like' });
// Honours the query's own live-row filter, so a query that drops it finds a deleted comment.
const comment = (state: 'live' | 'deleted' | 'missing') =>
  dbMock.dbWrite.$queryRaw.mockImplementationOnce((async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (state === 'missing' || (state === 'deleted' && sql.includes('"deletedAt" IS NULL')))
      return [];
    return [{ id: 1 }];
  }) as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toggleReaction on a CommentV3 comment', () => {
  it('adds the reaction to CommentV3Reaction after the block check', async () => {
    comment('live');
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
  });

  it('removes a reaction the user holds, without a block check', async () => {
    comment('live');
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(1);

    expect(await react(1)).toBe('removed');
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(blockCheck).not.toHaveBeenCalled();
  });

  it('adds nothing when the block check refuses', async () => {
    comment('live');
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0);
    blockCheck.mockRejectedValueOnce(new Error('blocked'));
    await expect(react(1)).rejects.toThrow('blocked');
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a reaction on a deleted comment', async () => {
    comment('deleted');
    await expect(react(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('is a no-op when the same reaction lands concurrently on a live comment', async () => {
    comment('live');
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    comment('live');
    expect(await react(1)).toBe('noop');
  });

  it('refuses when the comment is deleted between the check and the insert', async () => {
    comment('live');
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    comment('deleted');
    await expect(react(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    comment('live');
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    comment('missing');
    await expect(react(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a reaction on a comment that does not exist', async () => {
    comment('missing');
    await expect(react(1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
