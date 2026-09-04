import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

const { mockQueueUpdate } = vi.hoisted(() => ({ mockQueueUpdate: vi.fn() }));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  articlesSearchIndex: { queueUpdate: mockQueueUpdate },
}));

import { setArticleOfficial } from '~/server/services/article.service';

/**
 * The service's own moderator check, separate from the router's.
 *
 * Two checks for one boundary is deliberate and worth keeping: the router decides who may
 * CALL this, and this decides what the function does when someone calls it anyway. The
 * second is what protects a future caller — a job, a script, another service — that does
 * not go through `moderatorProcedure`. `setModelOfficial` is built the same way.
 */
describe('setArticleOfficial', () => {
  beforeEach(() => {
    mockQueueUpdate.mockReset();
    mockQueueUpdate.mockResolvedValue(undefined);
    dbMock.dbRead.article.findUnique.mockReset();
    dbMock.dbRead.article.findUnique.mockResolvedValue({ id: 7 });
    dbMock.dbWrite.article.update.mockReset();
    dbMock.dbWrite.article.update.mockResolvedValue({ id: 7, isOfficial: true });
  });

  it('refuses a non-moderator, and writes nothing', async () => {
    await expect(
      setArticleOfficial({ id: 7, isOfficial: true, isModerator: false })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });

  // The control for the refusal above: same call, moderator flag set. Without it, a
  // function that threw unconditionally would pass.
  it('writes the flag for a moderator', async () => {
    await expect(
      setArticleOfficial({ id: 7, isOfficial: true, isModerator: true })
    ).resolves.toEqual({ id: 7, isOfficial: true });

    expect(dbMock.dbWrite.article.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { isOfficial: true },
      select: { id: true, isOfficial: true },
    });
  });

  it('carries the value through rather than always marking official', async () => {
    dbMock.dbWrite.article.update.mockResolvedValue({ id: 7, isOfficial: false });

    await setArticleOfficial({ id: 7, isOfficial: false, isModerator: true });

    expect(dbMock.dbWrite.article.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isOfficial: false } })
    );
  });

  it('refuses an article that does not exist, and writes nothing', async () => {
    dbMock.dbRead.article.findUnique.mockResolvedValue(null);

    await expect(
      setArticleOfficial({ id: 404, isOfficial: true, isModerator: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(dbMock.dbWrite.article.update).not.toHaveBeenCalled();
  });

  // The search index document spreads `articleDetailSelect`, which carries `isOfficial`.
  // Without this the index keeps serving the old provenance until something else touches
  // the article — which for an article nobody edits is forever.
  it('queues a search-index update for the article it changed', async () => {
    await setArticleOfficial({ id: 7, isOfficial: true, isModerator: true });

    expect(mockQueueUpdate).toHaveBeenCalledWith([{ id: 7, action: 'Update' }]);
  });
});
