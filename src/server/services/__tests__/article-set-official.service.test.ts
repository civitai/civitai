import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

const { mockQueueUpdate, systemTags } = vi.hoisted(() => ({
  mockQueueUpdate: vi.fn(),
  systemTags: [] as { id: number; name: string }[],
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  articlesSearchIndex: { queueUpdate: mockQueueUpdate },
}));

vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSystemTags: async () => systemTags,
}));

const OFFICIAL_TAG = { id: 900, name: 'civitai official' };

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
    systemTags.splice(0, systemTags.length, OFFICIAL_TAG);
    dbMock.dbWrite.tagsOnArticle.createMany.mockReset();
    dbMock.dbWrite.tagsOnArticle.deleteMany.mockReset();
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
    expect(dbMock.dbWrite.tagsOnArticle.createMany).not.toHaveBeenCalled();
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

  // The chip filters on the tag row, not the column; a mark that wrote only the column would
  // badge the article but leave it out of the chip.
  it('attaches the civitai official tag when marking', async () => {
    await setArticleOfficial({ id: 7, isOfficial: true, isModerator: true });

    expect(dbMock.dbWrite.tagsOnArticle.createMany).toHaveBeenCalledWith({
      data: [{ articleId: 7, tagId: OFFICIAL_TAG.id }],
      skipDuplicates: true,
    });
    expect(dbMock.dbWrite.tagsOnArticle.deleteMany).not.toHaveBeenCalled();
  });

  it('removes the civitai official tag when unmarking', async () => {
    dbMock.dbWrite.article.update.mockResolvedValue({ id: 7, isOfficial: false });

    await setArticleOfficial({ id: 7, isOfficial: false, isModerator: true });

    expect(dbMock.dbWrite.tagsOnArticle.deleteMany).toHaveBeenCalledWith({
      where: { articleId: 7, tagId: OFFICIAL_TAG.id },
    });
    expect(dbMock.dbWrite.tagsOnArticle.createMany).not.toHaveBeenCalled();
  });

  // The code can deploy before the tag row is seeded; the mark must still succeed, and the
  // seed's backfill catches the tag up.
  it('still writes the column when the tag is not seeded', async () => {
    systemTags.splice(0, systemTags.length);

    await expect(
      setArticleOfficial({ id: 7, isOfficial: true, isModerator: true })
    ).resolves.toEqual({ id: 7, isOfficial: true });

    expect(dbMock.dbWrite.article.update).toHaveBeenCalled();
    expect(dbMock.dbWrite.tagsOnArticle.createMany).not.toHaveBeenCalled();
  });
});
