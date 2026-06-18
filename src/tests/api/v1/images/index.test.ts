import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// 1. Hoisted mocks for API and Service dependencies
const {
  mockGetAllImages,
  mockGetAllImagesIndex,
  mockGetImagesFromFeedSearch,
  mockImageMetaCacheFetch,
  mockGetServerAuthSession,
  mockGetFeatureFlags,
  mockGetFliptVariant,
} = vi.hoisted(() => ({
  mockGetAllImages: vi.fn(),
  mockGetAllImagesIndex: vi.fn(),
  mockGetImagesFromFeedSearch: vi.fn(),
  mockImageMetaCacheFetch: vi.fn(),
  mockGetServerAuthSession: vi.fn(),
  mockGetFeatureFlags: vi.fn(),
  mockGetFliptVariant: vi.fn(),
}));

vi.mock('~/server/services/image.service', () => ({
  getAllImages: mockGetAllImages,
  getAllImagesIndex: mockGetAllImagesIndex,
  getImagesFromFeedSearch: mockGetImagesFromFeedSearch,
}));

vi.mock('~/server/redis/caches', () => ({
  imageMetaCache: {
    fetch: mockImageMetaCacheFetch,
  },
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));

vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: mockGetFeatureFlags,
  buildFliptContext: vi.fn(),
}));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {
    BITDEX_IMAGE_SEARCH: 'bitdex-image-search',
  },
  getFliptVariant: mockGetFliptVariant,
}));

vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (url: string) => `https://cf-images.com/${url}`,
}));

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: vi.fn().mockReturnValue('US'),
  isRegionRestricted: vi.fn().mockReturnValue(false),
}));

vi.mock('~/server/meilisearch/client', () => ({
  buildSearchActor: vi.fn().mockReturnValue('mock-actor'),
}));

vi.mock('request-ip', () => ({
  default: { getClientIp: () => '127.0.0.1' },
}));

// Mock PublicEndpoint to be a simple passthrough wrapper
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => handler,
}));

// 2. Import the handler after the mocks are defined
import handler from '~/pages/api/v1/images/index';

// 3. Helper to mock NextApiRequest/Response
function createMocks({ query = {} }: { query?: Record<string, string | string[]> }) {
  const req = {
    method: 'GET',
    headers: {},
    query,
  } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: any = undefined;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: any) {
      payload = body;
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
  } as unknown as NextApiResponse & { _getStatusCode: () => number; _getJSONData: () => any };

  return { req, res };
}

// 4. Test Suite
describe('/api/v1/images API Handler', () => {
  const mockImagesResult = {
    items: [
      {
        id: 100,
        url: 'test-uuid',
        hash: 'U36kF+Z#',
        width: 832,
        height: 1216,
        nsfwLevel: 1,
        type: 'image',
        createdAt: new Date('2026-03-04T16:10:46.428Z'),
        postId: 27016856,
        stats: {
          cryCountAllTime: 4,
          laughCountAllTime: 7,
          likeCountAllTime: 154,
          dislikeCountAllTime: 0,
          heartCountAllTime: 47,
          commentCountAllTime: 1,
        },
        user: {
          username: 'forest919',
        },
        baseModel: 'Anima',
        modelVersionIds: [2653283],
        tags: [
          { id: 1, name: 'anime' },
          { id: 2, name: 'portrait' },
        ],
      },
    ],
    nextCursor: 'cursor_val',
  };

  const mockMetaResult = {
    100: {
      id: 100,
      meta: {
        Model: 'anima-preview',
        cfgScale: 4,
        prompt: 'masterpiece, best quality',
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerAuthSession.mockResolvedValue(null);
    mockGetFeatureFlags.mockReturnValue({ datapacketRead: false, canViewNsfw: false });
    mockGetFliptVariant.mockResolvedValue('off'); // Default to Meili feed search
    mockGetImagesFromFeedSearch.mockResolvedValue(mockImagesResult);
    mockGetAllImagesIndex.mockResolvedValue(mockImagesResult);
    mockGetAllImages.mockResolvedValue(mockImagesResult);
    mockImageMetaCacheFetch.mockResolvedValue(mockMetaResult);
  });

  it('should return meta: null by default (when withMeta is false) and NOT fetch from cache', async () => {
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].meta).toBeNull();
    expect(mockImageMetaCacheFetch).not.toHaveBeenCalled();

    // Verify search service call had withMeta = false to prevent search index filtering
    expect(mockGetImagesFromFeedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        withMeta: false,
      })
    );
  });

  it('should omit tags by default (when withTags is false)', async () => {
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].tags).toBeUndefined();
    expect(mockGetImagesFromFeedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.not.arrayContaining(['tags']),
      })
    );
  });

  it('should return tags when withTags=true', async () => {
    const { req, res } = createMocks({ query: { limit: '10', withTags: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].tags).toEqual([
      { id: 1, name: 'anime' },
      { id: 2, name: 'portrait' },
    ]);
    expect(mockGetImagesFromFeedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.arrayContaining(['tags']),
      })
    );
  });

  it('should return tags with withTags=true on legacy path', async () => {
    const { req, res } = createMocks({ query: { imageId: '100', withTags: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].tags).toEqual([
      { id: 1, name: 'anime' },
      { id: 2, name: 'portrait' },
    ]);
    expect(mockGetAllImages).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.arrayContaining(['tags']),
      })
    );
  });

  it('should return flat shape by default when withMeta=true on default search/feed query path', async () => {
    const { req, res } = createMocks({ query: { limit: '10', withMeta: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].meta).toEqual({
      Model: 'anima-preview',
      cfgScale: 4,
      prompt: 'masterpiece, best quality',
    });
    expect(mockGetImagesFromFeedSearch).toHaveBeenCalled();
  });

  it('should return nested wrapper shape by default when withMeta=true on legacy query path (e.g. imageId)', async () => {
    const { req, res } = createMocks({ query: { imageId: '100', withMeta: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].meta).toEqual({
      id: 100,
      meta: {
        Model: 'anima-preview',
        cfgScale: 4,
        prompt: 'masterpiece, best quality',
      },
    });
    expect(mockGetAllImages).toHaveBeenCalled();
  });

  it('should return nested shape when flatMeta=false is explicitly passed, regardless of path', async () => {
    const { req, res } = createMocks({ query: { limit: '10', withMeta: 'true', flatMeta: 'false' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].meta).toEqual({
      id: 100,
      meta: {
        Model: 'anima-preview',
        cfgScale: 4,
        prompt: 'masterpiece, best quality',
      },
    });
  });

  it('should return flat shape when flatMeta=true is explicitly passed, regardless of path', async () => {
    const { req, res } = createMocks({ query: { imageId: '100', withMeta: 'true', flatMeta: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].meta).toEqual({
      Model: 'anima-preview',
      cfgScale: 4,
      prompt: 'masterpiece, best quality',
    });
  });

  it('should return consistent nested wrapper for data-less images (meta: null, not bare null)', async () => {
    // Image has no meta in cache — the wrapper shape must still be emitted, not bare null
    mockImageMetaCacheFetch.mockResolvedValue({ 100: { id: 100, meta: undefined } });
    const { req, res } = createMocks({ query: { imageId: '100', withMeta: 'true', flatMeta: 'false' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    // Must be the wrapper shape, not bare null
    expect(data.items[0].meta).toEqual({ id: 100, meta: null });
  });

  it('should return null (not a wrapper) for data-less images in flat mode', async () => {
    mockImageMetaCacheFetch.mockResolvedValue({ 100: { id: 100, meta: undefined } });
    const { req, res } = createMocks({ query: { limit: '10', withMeta: 'true', flatMeta: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].meta).toBeNull();
  });

  it('should route to getAllImagesIndex when BitDex Flipt variant is shadow', async () => {
    mockGetFliptVariant.mockResolvedValue('shadow');
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetAllImagesIndex).toHaveBeenCalled();
    expect(mockGetImagesFromFeedSearch).not.toHaveBeenCalled();
    expect(mockGetAllImages).not.toHaveBeenCalled();
  });

  it('should route to getAllImagesIndex when BitDex Flipt variant is primary', async () => {
    mockGetFliptVariant.mockResolvedValue('primary');
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetAllImagesIndex).toHaveBeenCalled();
    expect(mockGetImagesFromFeedSearch).not.toHaveBeenCalled();
    expect(mockGetAllImages).not.toHaveBeenCalled();
  });

  it('should pass withMeta:false to getAllImages on legacy path regardless of query param', async () => {
    const { req, res } = createMocks({ query: { imageId: '100', withMeta: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetAllImages).toHaveBeenCalledWith(
      expect.objectContaining({ withMeta: false })
    );
  });

  it('should pass withMeta:false to getAllImagesIndex on BitDex path regardless of query param', async () => {
    mockGetFliptVariant.mockResolvedValue('shadow');
    const { req, res } = createMocks({ query: { limit: '10', withMeta: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetAllImagesIndex).toHaveBeenCalledWith(
      expect.objectContaining({ withMeta: false })
    );
  });

  it('should return tags with withTags=true on BitDex path', async () => {
    mockGetFliptVariant.mockResolvedValue('shadow');
    const { req, res } = createMocks({ query: { limit: '10', withTags: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].tags).toEqual([
      { id: 1, name: 'anime' },
      { id: 2, name: 'portrait' },
    ]);
    expect(mockGetAllImagesIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.arrayContaining(['tags']),
      })
    );
  });

  it('should not pass tags in include to BitDex when withTags is false', async () => {
    mockGetFliptVariant.mockResolvedValue('shadow');
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].tags).toBeUndefined();
    expect(mockGetAllImagesIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.not.arrayContaining(['tags']),
      })
    );
  });

  it('should return empty tags array when image has no tags', async () => {
    mockGetImagesFromFeedSearch.mockResolvedValue({
      ...mockImagesResult,
      items: [{ ...mockImagesResult.items[0], tags: [] }],
    });
    const { req, res } = createMocks({ query: { limit: '10', withTags: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].tags).toEqual([]);
  });

  it('should return empty tags array when image tags field is absent', async () => {
    const { tags: _, ...itemWithoutTags } = mockImagesResult.items[0];
    mockGetImagesFromFeedSearch.mockResolvedValue({
      ...mockImagesResult,
      items: [itemWithoutTags],
    });
    const { req, res } = createMocks({ query: { limit: '10', withTags: 'true' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.items[0].tags).toEqual([]);
  });
});
