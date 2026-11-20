import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userModelCountCache } from '~/server/redis/caches';
import { modelsSearchIndex } from '~/server/search-index/models.search-index';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';

afterEach(() => {
  vi.restoreAllMocks();
  dbMock.dbWrite.$queryRaw.mockReset();
});

describe('updateModelNsfwLevels', () => {
  it("refreshes each owner's model counts once per batch after a rating recompute", async () => {
    vi.spyOn(modelsSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);
    const refresh = vi.spyOn(userModelCountCache, 'refresh').mockResolvedValue();
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 1, userId: 7 },
      { id: 2, userId: 7 },
      { id: 3, userId: 9 },
    ]);

    await updateModelNsfwLevels([1, 2, 3]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith([7, 9]);
  });

  it('refreshes nothing when no model level changed', async () => {
    vi.spyOn(modelsSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);
    const refresh = vi.spyOn(userModelCountCache, 'refresh').mockResolvedValue();
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    await updateModelNsfwLevels([1]);

    expect(refresh).not.toHaveBeenCalled();
  });
});
