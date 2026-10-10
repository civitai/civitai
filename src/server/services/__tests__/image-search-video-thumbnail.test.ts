import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type * as Caches from '~/server/redis/caches';

vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: vi.fn(() => ({ canViewNsfw: true, datapacketRead: false })),
  buildFliptContext: vi.fn(() => ({})),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  getFliptVariant: vi.fn(async () => 'off'),
}));

const thumbnailFetch = vi.fn<(ids: number[]) => Promise<Record<number, unknown>>>(async () => ({}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    imageMetaCache: { ...actual.imageMetaCache, fetch: vi.fn(async () => ({})) },
    thumbnailCache: { ...actual.thumbnailCache, fetch: (ids: number[]) => thumbnailFetch(ids) },
  };
});

const feedSearch = vi.fn(async () => ({ items: [] as unknown[], nextCursor: undefined }));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getAllImagesIndex: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  getImagesFromFeedSearch: (...args: unknown[]) => feedSearch(...(args as [])),
}));

import { runImageSearch } from '../image-search.service';

const req = {
  headers: { 'user-agent': 'probe/1.0' },
  socket: { remoteAddress: '203.0.113.7' },
} as unknown as NextApiRequest;

function item(id: number, type: 'image' | 'video') {
  return {
    id,
    url: `uuid-${id}`,
    hash: 'h',
    width: 1280,
    height: 704,
    nsfwLevel: 1,
    type,
    metadata: { width: 1280, height: 704, duration: 5 },
    createdAt: new Date(0),
    postId: 1,
    stats: {},
    user: { id: 1, username: 'alice' },
    baseModel: null,
    modelVersionIds: [],
  };
}

async function search(items: unknown[], browsingLevel = 1) {
  feedSearch.mockResolvedValue({ items, nextCursor: undefined });
  const result = await runImageSearch(
    { limit: items.length, withMeta: false, withTags: false, data: {} } as never,
    { browsingLevel, user: undefined, req } as never
  );
  return result.items;
}

describe('runImageSearch: video thumbnails', () => {
  beforeEach(() => {
    thumbnailFetch.mockReset();
    thumbnailFetch.mockResolvedValue({});
  });

  it('gives an image no thumbnail and does not look one up', async () => {
    const [image] = await search([item(1, 'image')]);

    expect(image.thumbnail).toBeNull();
    expect(thumbnailFetch).not.toHaveBeenCalled();
  });

  it('gives a video its uploaded thumbnail, with that thumbnail’s dimensions', async () => {
    thumbnailFetch.mockResolvedValue({
      2: { id: 99, url: 'thumb-uuid', width: 832, height: 1216, nsfwLevel: 1, parentId: 2 },
    });

    const [, video] = await search([item(1, 'image'), item(2, 'video')]);

    expect(thumbnailFetch).toHaveBeenCalledTimes(1);
    expect(thumbnailFetch).toHaveBeenCalledWith([2]);
    expect(video.thumbnail).toEqual({
      url: expect.stringMatching(/(^|\/)thumb-uuid\/anim=false,optimized=true\/thumb-uuid\.jpeg$/),
      width: 832,
      height: 1216,
    });
  });

  it('falls back to a frame when the uploaded thumbnail is above the browsing level', async () => {
    thumbnailFetch.mockResolvedValue({
      2: { id: 99, url: 'thumb-uuid', width: 832, height: 1216, nsfwLevel: 16, parentId: 2 },
    });

    const [video] = await search([item(2, 'video')], 1);

    expect(video.thumbnail).toEqual({
      url: expect.stringMatching(/(^|\/)uuid-2\/anim=false,transcode=true,optimized=true\//),
      width: 1280,
      height: 704,
    });
  });
});
