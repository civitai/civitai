import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as TagService from '~/server/services/tag.service';
import type { SessionUser } from '~/types/session';

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  getVotableImageTags: vi.fn(async () => []),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    thumbnailCache: { ...actual.thumbnailCache, fetch: vi.fn(async () => ({})) },
  };
});

import { getPostEditImages } from '~/server/services/post.service';

const row = (id: number, index: number | null) => ({ id, index, tools: [], techniques: [] });

/**
 * Uploads made while an earlier one was still in flight could share an index. The editor shows
 * the post in the order this returns, so a tie must fall back to upload order (id) instead of
 * whatever order the rows came back in.
 */
describe('getPostEditImages order', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orders images that share an index by id', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([
      row(30, 3),
      row(11, 1),
      row(10, 1),
      row(21, 3),
      row(5, 2),
    ] as never);

    const images = await getPostEditImages({ id: 1, user: { id: 1 } as SessionUser });

    expect(images.map((x) => x.id)).toEqual([10, 11, 5, 21, 30]);
  });
});
