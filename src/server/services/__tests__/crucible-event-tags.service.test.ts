import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as HomeBlockCacheService from '~/server/services/home-block-cache.service';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

const { homeBlockCacheBustMock } = vi.hoisted(() => ({ homeBlockCacheBustMock: vi.fn() }));

vi.mock('~/server/services/home-block-cache.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockCacheService>()),
  homeBlockCacheBust: homeBlockCacheBustMock,
}));

const { setCrucibleEventTags } = await import('~/server/services/crucible.service');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.crucible.findUnique.mockResolvedValue({ id: 1 });
  dbMock.dbWrite.crucible.update.mockResolvedValue({ eventTags: ['halloween'] });
  dbMock.dbRead.homeBlock.findMany.mockResolvedValue([
    { id: 10, metadata: { feed: { entity: 'crucibles', eventTag: 'halloween' } } },
    { id: 11, metadata: { feed: { entity: 'images' } } },
    { id: 12, metadata: { feed: { entity: 'crucibles', eventTag: 'winter' } } },
  ]);
});

describe('setCrucibleEventTags', () => {
  // A crucibles block caches its slice, empty ones included, for 10 minutes. Without the bust a
  // moderator tags the first crucible and the homepage section stays hidden until it expires.
  it('clears every crucibles Feed block so a tag change reaches the homepage', async () => {
    await expect(setCrucibleEventTags({ id: 1, eventTags: ['halloween'] })).resolves.toEqual([
      'halloween',
    ]);

    expect(homeBlockCacheBustMock.mock.calls).toEqual([
      [HomeBlockType.Feed, 10],
      [HomeBlockType.Feed, 12],
    ]);
  });

  // The save has committed before the bust runs; reporting failure would leave the moderator's
  // panel showing the old tags while the database holds the new ones.
  it('still reports the saved tags when clearing the cache fails', async () => {
    homeBlockCacheBustMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(setCrucibleEventTags({ id: 1, eventTags: ['halloween'] })).resolves.toEqual([
      'halloween',
    ]);
  });

  it('refuses a crucible that does not exist, and clears nothing', async () => {
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue(null);

    await expect(setCrucibleEventTags({ id: 404, eventTags: [] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbWrite.crucible.update).not.toHaveBeenCalled();
    expect(homeBlockCacheBustMock).not.toHaveBeenCalled();
  });
});
