import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as Caches from '~/server/redis/caches';
import type * as ImageService from '~/server/services/image.service';
import type * as TagService from '~/server/services/tag.service';
import type { SessionUser } from '~/types/session';

const { getImageMetricsObject, getPostDetailRow, getUserWithCosmetics } = vi.hoisted(() => ({
  getImageMetricsObject: vi.fn(),
  getPostDetailRow: vi.fn(),
  getUserWithCosmetics: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getPostDetailRow,
  getUserWithCosmetics,
}));

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
  getKyselyWithoutLag: vi.fn(async () => (await import('~/server/db/kyselyDb')).kyselyRead),
}));
vi.mock('~/server/services/tag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TagService>()),
  getVotableImageTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImageMetricsObject,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    thumbnailCache: { ...actual.thumbnailCache, fetch: vi.fn(async () => ({})) },
  };
});

import {
  getPostEditDetail,
  getPostEditImages,
  withReactionCounts,
} from '~/server/services/post.service';

const metric = (
  imageId: number,
  like: number | null,
  heart: number | null,
  laugh: number | null = null,
  cry: number | null = null
) => ({
  imageId,
  reactionLike: like,
  reactionHeart: heart,
  reactionLaugh: laugh,
  reactionCry: cry,
});
const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);

describe('withReactionCounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums the reaction types of a published post in one metrics read', async () => {
    getImageMetricsObject.mockResolvedValue({
      1: metric(1, 3, 2, 1, 1),
      2: metric(2, null, null),
    });

    const result = await withReactionCounts([{ id: 1 }, { id: 2 }, { id: 3 }], past);

    expect(getImageMetricsObject).toHaveBeenCalledTimes(1);
    // 1: 3 + 2 + 1 + 1, all four types. 2: every field null means unknown, not 0. 3: the read did not resolve it.
    expect(result).toEqual([{ id: 1, reactionCount: 7 }, { id: 2 }, { id: 3 }]);
  });

  it('reads nothing for a draft or a scheduled post', async () => {
    await withReactionCounts([{ id: 1 }], null);
    await withReactionCounts([{ id: 1 }], future);

    expect(getImageMetricsObject).not.toHaveBeenCalled();
  });
});

describe('combinePostEditImageData, shared with the upload path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads no metrics through getPostEditImages (addPostImage itself is not run here)', async () => {
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([
      { id: 1, index: 1, tools: [], techniques: [] },
    ] as never);

    const images = await getPostEditImages({ id: 1, user: { id: 1 } as SessionUser });

    expect(images).toHaveLength(1);
    expect(getImageMetricsObject).not.toHaveBeenCalled();
  });
});

describe('getPostEditDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  const givenPost = (publishedAt: Date | null) => {
    getPostDetailRow.mockResolvedValue({
      id: 1,
      publishedAt,
      modelVersionId: null,
      publishedModelVersionId: null,
      userId: 7,
      tags: [],
    });
    getUserWithCosmetics.mockResolvedValue({
      id: 7,
      username: 'owner',
      deletedAt: null,
      image: null,
      profilePictureId: null,
      cosmetics: [],
    });
    vi.mocked(dbMock.dbRead.image.findMany).mockResolvedValue([
      { id: 1, index: 1, tools: [], techniques: [] },
    ] as never);
  };
  const owner = { id: 7, isModerator: false } as SessionUser;

  it('puts the reaction count on each image of a published post', async () => {
    givenPost(past);
    getImageMetricsObject.mockResolvedValue({ 1: metric(1, 4, 1) });

    const post = await getPostEditDetail({ id: 1, user: owner });

    expect(post.images[0].reactionCount).toBe(5);
  });

  it('reads no metrics for a draft', async () => {
    givenPost(null);

    const post = await getPostEditDetail({ id: 1, user: owner });

    expect(post.images[0].reactionCount).toBeUndefined();
    expect(getImageMetricsObject).not.toHaveBeenCalled();
  });
});
