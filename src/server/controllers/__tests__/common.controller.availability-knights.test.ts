import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { Context } from '~/server/createContext';
import { updateEntityAvailabilityHandler } from '~/server/controllers/common.controller';
import { entityAvailabilityUpdate } from '~/server/services/common.service';
import { queueLeftPrivateForKnights } from '~/server/services/knights/sources';
import { Availability } from '~/shared/utils/prisma/enums';

vi.mock('~/server/services/common.service', () => ({
  entityAvailabilityUpdate: vi.fn(),
  hasEntityAccess: vi.fn(),
}));
vi.mock('~/server/services/knights/sources', () => ({ queueLeftPrivateForKnights: vi.fn() }));
vi.mock('~/server/search-index', () => {
  const index = () => ({ queueUpdate: vi.fn() });
  return {
    articlesSearchIndex: index(),
    bountiesSearchIndex: index(),
    collectionsSearchIndex: index(),
    imagesMetricsSearchIndex: index(),
    imagesSearchIndex: index(),
    modelsSearchIndex: index(),
  };
});

const setPost = (availability: Availability) =>
  updateEntityAvailabilityHandler({
    ctx: {} as Context,
    input: { entityType: 'Post', entityId: 5, availability },
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findMany.mockResolvedValue([{ id: 50 }]);
});

describe('updateEntityAvailabilityHandler on a Post', () => {
  it("offers the post's images to Knights after the availability is written", async () => {
    await setPost(Availability.Public);

    expect(vi.mocked(queueLeftPrivateForKnights).mock.calls).toEqual([[{ postIds: [5] }]]);
    expect(vi.mocked(queueLeftPrivateForKnights).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(entityAvailabilityUpdate).mock.invocationCallOrder[0]
    );
  });

  it('offers nothing when the post is set to Private (control)', async () => {
    await setPost(Availability.Private);

    expect(entityAvailabilityUpdate).toHaveBeenCalled();
    expect(queueLeftPrivateForKnights).not.toHaveBeenCalled();
  });
});
