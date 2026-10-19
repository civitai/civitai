import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mocks = vi.hoisted(() => ({
  queueImageSearchIndexUpdate: vi.fn(),
  refreshPostCount: vi.fn(),
  refreshMediaCount: vi.fn(),
}));

vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: mocks.queueImageSearchIndexUpdate,
}));
vi.mock('~/server/redis/caches', () => ({
  userPostCountCache: { refresh: mocks.refreshPostCount },
  userImageVideoCountCaches: { refresh: mocks.refreshMediaCount },
}));

const { unpublishPostAsModerator } = await import('~/server/services/post.service');

const sqlOf = (call: unknown[]) => (call[0] as readonly string[]).join('?');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 55, userId: 900 }]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
});

describe('unpublishPostAsModerator', () => {
  it('clears publishedAt and stamps who, when and why, stashing the previous date', async () => {
    await unpublishPostAsModerator({ id: 55, userId: 7, reason: 'csam-text-hold' });
    const call = dbMock.dbWrite.$queryRaw.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toContain('UPDATE "Post"');
    expect(sql).toContain('"publishedAt" = NULL');
    for (const key of ['unpublishedAt', 'unpublishedBy', 'prevPublishedAt', 'unpublishedReason'])
      expect(sql).toContain(key);
    expect(sql).toContain('"publishedAt" IS NOT NULL');
    // A post with NULL metadata would otherwise get no stamps and could not be restored.
    expect(sql).toContain('COALESCE("metadata"');
    expect(call.slice(1)).toEqual(expect.arrayContaining([7, 'csam-text-hold', 55]));
  });

  it('never deletes the post or its images', async () => {
    await unpublishPostAsModerator({ id: 55, userId: 7, reason: 'r' });
    expect(dbMock.dbWrite.post.delete).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.deleteMany).not.toHaveBeenCalled();
    for (const call of dbMock.dbWrite.$queryRaw.mock.calls)
      expect(sqlOf(call)).not.toMatch(/DELETE/i);
  });

  it('takes the images out of the search index and refreshes the author counts', async () => {
    await unpublishPostAsModerator({ id: 55, userId: 7, reason: 'r' });
    expect(mocks.queueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [1, 2],
      action: 'Delete',
    });
    expect(mocks.refreshPostCount).toHaveBeenCalledWith(900);
    expect(mocks.refreshMediaCount).toHaveBeenCalledWith(900);
  });

  it('does nothing further for a post that is not published', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await expect(unpublishPostAsModerator({ id: 55, userId: 7, reason: 'r' })).resolves.toEqual({
      unpublished: false,
    });
    expect(mocks.queueImageSearchIndexUpdate).not.toHaveBeenCalled();
  });
});
