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
  it("re-checks the covers of mature models whose .com cover is someone else's image", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 1, communityComCover: true },
      { id: 2, communityComCover: false },
    ]);

    await updateModelNsfwLevels([1, 2]);

    expect(dropInvalidCommunityCovers).toHaveBeenCalledWith([1]);
  });

  it('skips the re-check when no mature model has a community .com cover', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 2, communityComCover: false }]);

    await updateModelNsfwLevels([2]);

    expect(dropInvalidCommunityCovers).not.toHaveBeenCalled();
  });
});
