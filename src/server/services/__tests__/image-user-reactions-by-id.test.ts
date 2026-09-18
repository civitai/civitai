import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Capture from '~/server/services/feed-request-capture.service';

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/feed-request-capture.service', async (importOriginal) => {
  const actual = await importOriginal<typeof Capture>();
  return { ...actual, feedRequestCapture: () => ({ record: async () => undefined }) };
});

import { getUserReactionsForImages } from '../image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const VIEWER = 9266475;

describe('getUserReactionsForImages', () => {
  beforeEach(() => {
    dbMock.dbRead.imageReaction.findMany.mockReset();
    dbMock.dbRead.imageReaction.findMany.mockResolvedValue([]);
  });

  it('groups the viewer reactions by image', async () => {
    dbMock.dbRead.imageReaction.findMany.mockResolvedValue([
      { imageId: 142799705, reaction: 'Like' },
      { imageId: 142799705, reaction: 'Heart' },
      { imageId: 2, reaction: 'Cry' },
    ]);

    await expect(
      getUserReactionsForImages({ imageIds: [142799705, 2], userId: VIEWER })
    ).resolves.toEqual({ 142799705: ['Like', 'Heart'], 2: ['Cry'] });
  });

  it('asks only for the viewer own rows', async () => {
    await getUserReactionsForImages({ imageIds: [1, 2], userId: VIEWER });

    // Dropping `userId` here returns every viewer's reactions, and the merge credits all of them
    // to the current one — so every image on the front page would draw as already reacted, and
    // the first click on any of them would create a reaction rather than the removal it looks
    // like. That is the inverse of the bug this function exists to fix.
    expect(dbMock.dbRead.imageReaction.findMany).toHaveBeenCalledWith({
      where: { imageId: { in: [1, 2] }, userId: VIEWER },
      select: { imageId: true, reaction: true },
    });
  });

  it('does not query at all for an empty set of ids', async () => {
    await expect(getUserReactionsForImages({ imageIds: [], userId: VIEWER })).resolves.toEqual({});

    expect(dbMock.dbRead.imageReaction.findMany).not.toHaveBeenCalled();
  });
});
