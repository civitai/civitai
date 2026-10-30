import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { refreshThumbnailCache, thumbnailCache } from '~/server/redis/caches';

describe('refreshThumbnailCache', () => {
  const refresh = vi.spyOn(thumbnailCache, 'refresh');

  beforeEach(() => {
    refresh.mockReset().mockResolvedValue(undefined as never);
    dbMock.dbWrite.$queryRaw.mockClear();
  });

  it('refreshes the parent video when given a thumbnail image id', async () => {
    // The cache is keyed by the VIDEO id; refreshing only the thumbnail's own id leaves the
    // video's entry holding the thumbnail's old nsfwLevel until the TTL expires.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ parentId: 500 }]);

    await refreshThumbnailCache([77]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toEqual(expect.arrayContaining([77, 500]));
  });

  it('still refreshes ids that are not thumbnails', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    await refreshThumbnailCache(12);

    expect(refresh).toHaveBeenCalledWith([12]);
  });

  it('skips a row whose parent cannot be read', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ parentId: null }]);

    await refreshThumbnailCache([12]);

    expect(refresh).toHaveBeenCalledWith([12]);
  });

  it('does nothing for an empty list', async () => {
    await refreshThumbnailCache([]);

    expect(refresh).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});
