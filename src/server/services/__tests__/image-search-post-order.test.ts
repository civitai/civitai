import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

/**
 * `postOrder` serves a post's images from the DB path, which orders a post query by the uploader's
 * `index`. Feed search ranks by `sort` across the whole post, so a post with more images than the
 * page holds would return the top-ranked ones instead of the first ones. Without `postOrder`, a
 * `postId` query must stay on the feed path so `/api/v1/images?postId=` keeps honouring `sort`.
 */

vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: vi.fn(() => ({ canViewNsfw: true, datapacketRead: false })),
  buildFliptContext: vi.fn(() => ({})),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  getFliptVariant: vi.fn(async () => 'off'),
}));
vi.mock('~/server/redis/caches', () => ({
  imageMetaCache: { fetch: vi.fn(async () => ({})) },
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: vi.fn(() => 'https://edge/x') }));

const feedSearch = vi.fn(async (_input?: unknown) => ({
  items: [] as unknown[],
  nextCursor: undefined as string | undefined,
}));
const legacySearch = vi.fn(async (_input?: unknown) => ({
  items: [] as unknown[],
  nextCursor: undefined as string | undefined,
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: (...args: unknown[]) => legacySearch(...(args as [unknown])),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getImagesFromFeedSearch: (...args: unknown[]) => feedSearch(...(args as [unknown])),
}));

import { runImageSearch } from '../image-search.service';

const req = {
  headers: { 'user-agent': 'probe/1.0' },
  socket: { remoteAddress: '203.0.113.7' },
} as unknown as NextApiRequest;

const POST_ID = 31397997;

function image(id: number) {
  return {
    id,
    url: `u-${id}`,
    hash: 'h',
    width: 512,
    height: 768,
    nsfwLevel: 1,
    type: 'image',
    createdAt: new Date(0),
    postId: POST_ID,
    stats: {},
    user: { id: 4768, username: 'someone' },
    baseModel: 'SD 1.5',
    modelVersionIds: [],
    tags: [],
  };
}

// Disjoint and the same length, so only the returned ids tell the two paths apart.
const IN_POST_ORDER = [501, 502, 503];
const BY_REACTIONS = [903, 901, 902];

function run(postOrder?: boolean, throwOnStatementTimeout?: boolean) {
  return runImageSearch(
    {
      limit: 100,
      withMeta: false,
      withTags: false,
      postOrder,
      throwOnStatementTimeout,
      data: { postId: POST_ID, sort: 'Most Reactions' },
    } as never,
    { browsingLevel: 1, user: undefined, req } as never
  );
}

describe('runImageSearch — postOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    feedSearch.mockResolvedValue({ items: BY_REACTIONS.map(image), nextCursor: undefined });
    legacySearch.mockResolvedValue({ items: IN_POST_ORDER.map(image), nextCursor: undefined });
  });

  it('serves a post from the DB path, in the order it returns', async () => {
    const { items } = await run(true);

    expect(feedSearch).not.toHaveBeenCalled();
    expect(legacySearch).toHaveBeenCalledTimes(1);
    expect(legacySearch.mock.calls[0][0]).toMatchObject({ postId: POST_ID, limit: 100 });
    expect(items.map((i) => i.id)).toEqual(IN_POST_ORDER);
  });

  it.each([undefined, false, true])(
    'forwards the explicit timeout policy %s to the DB query',
    async (policy) => {
      await run(true, policy);

      expect(legacySearch).toHaveBeenCalledTimes(1);
      expect(legacySearch.mock.calls[0][0]).toHaveProperty('throwOnStatementTimeout', policy);
      expect(feedSearch).not.toHaveBeenCalled();
    }
  );

  it('does not accept a timeout policy from selector data', async () => {
    await runImageSearch(
      {
        limit: 100,
        withMeta: false,
        withTags: false,
        postOrder: true,
        data: { postId: POST_ID, sort: 'Newest', throwOnStatementTimeout: true },
      },
      { browsingLevel: 1, user: undefined, req }
    );

    expect(legacySearch.mock.calls[0][0]).toHaveProperty('throwOnStatementTimeout', undefined);
  });

  it('propagates an opted-in timeout without returning a page or falling back to the feed', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    legacySearch.mockRejectedValue(timeout);

    await expect(run(true, true)).rejects.toBe(timeout);

    expect(legacySearch).toHaveBeenCalledTimes(1);
    expect(feedSearch).not.toHaveBeenCalled();
  });

  it('preserves the continuation signal while shaping the returned images', async () => {
    legacySearch.mockResolvedValue({ items: IN_POST_ORDER.map(image), nextCursor: '0' });

    const { items, nextCursor } = await run(true, true);

    expect(items.map((i) => i.id)).toEqual(IN_POST_ORDER);
    expect(nextCursor).toBe('0');
    expect(legacySearch).toHaveBeenCalledTimes(1);
  });

  it('leaves a postId query without postOrder on the feed path', async () => {
    const { items } = await run();

    expect(legacySearch).not.toHaveBeenCalled();
    expect(items.map((i) => i.id)).toEqual(BY_REACTIONS);
  });

  it('does nothing without a postId', async () => {
    await runImageSearch(
      { limit: 10, withMeta: false, withTags: false, postOrder: true, data: {} } as never,
      { browsingLevel: 1, user: undefined, req } as never
    );

    expect(legacySearch).not.toHaveBeenCalled();
    expect(feedSearch).toHaveBeenCalledTimes(1);
  });
});
