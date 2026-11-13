import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
const dropInvalidCommunityCovers = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/version-showcase.service', () => ({ dropInvalidCommunityCovers }));

const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateModelNsfwLevels: a model turned mature', () => {
  it('re-checks the covers of the mature models it recomputed', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 1, nsfw: true },
      { id: 2, nsfw: false },
    ]);

    await updateModelNsfwLevels([1, 2]);

    expect(dropInvalidCommunityCovers).toHaveBeenCalledWith([1]);
  });

  it('skips the re-check when no recomputed model is mature', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 2, nsfw: false }]);

    await updateModelNsfwLevels([2]);

    expect(dropInvalidCommunityCovers).not.toHaveBeenCalled();
  });

  it('still finishes the recompute when the re-check fails', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 1, nsfw: true }]);
    dropInvalidCommunityCovers.mockRejectedValue(new Error('showcase table missing'));

    await expect(updateModelNsfwLevels([1])).resolves.toBeUndefined();
  });
});
