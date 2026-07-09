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

// Keep the REAL isTransientMeiliError (+ the error classes it tests against) so
// the handler's 500→503 classification branch runs its production logic; only
// buildSearchActor is stubbed. importOriginal pulls the real module; env/prom
// at its module load are tolerated (no real connection opens in test).
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/meilisearch/client')>();
  return {
    ...actual,
    buildSearchActor: vi.fn().mockReturnValue('mock-actor'),
  };
});

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
  let ended = false;
  const headers: Record<string, string> = {};

  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: any) {
      payload = body;
      return res;
    },
    end() {
      ended = true;
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getHeader: (name: string) => headers[name.toLowerCase()],
    _ended: () => ended,
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => any;
    _getHeader: (name: string) => string | undefined;
    _ended: () => boolean;
  };

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

// ─── Transient upstream → retryable 503 (500→503 reclassification) ───────────
//
// The dominant remaining HTTP-500 source on this endpoint is the heavy per-user
// feed (sort=Most Reactions & period=Year & withMeta=true) hitting a slow /
// shed Meili backend. The feed library's inner meilisearch-js (0.33) calls
// throw the SDK's OWN error types (MeiliSearchCommunicationError with
// statusCode=408/503, MeiliSearchApiError with httpStatus, MeiliSearchTimeOutError)
// — NOT TRPCErrors — so they were defaulting to a hard 500 with a bare
// {"error":"Request Timeout"} / {"error":"Service Unavailable"} body. The
// handler now classifies these (via isTransientMeiliError) as a retryable 503
// with Cache-Control: no-store + Retry-After. A genuine app error / NOT_FOUND
// must still map to its real status — NOT be masked as 503.
describe('/api/v1/images transient-upstream 503 reclassification', () => {
  // Faithful meilisearch-js 0.33 error shapes (see client.ts isTransientMeiliError).
  const makeCommunicationError = (statusCode: number) => {
    const e = new Error(statusCode === 408 ? 'Request Timeout' : 'Service Unavailable') as Error & {
      name: string;
      statusCode: number;
    };
    e.name = 'MeiliSearchCommunicationError';
    e.statusCode = statusCode;
    return e;
  };
  const makeApiError = (httpStatus: number) => {
    const e = new Error('meilisearch upstream error') as Error & {
      name: string;
      httpStatus: number;
    };
    e.name = 'MeiliSearchApiError';
    e.httpStatus = httpStatus;
    return e;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerAuthSession.mockResolvedValue(null);
    mockGetFeatureFlags.mockReturnValue({ datapacketRead: false, canViewNsfw: false });
    mockGetFliptVariant.mockResolvedValue('off'); // route to getImagesFromFeedSearch
    mockImageMetaCacheFetch.mockResolvedValue({});
  });

  it.each([408, 429, 502, 503, 504])(
    'maps a MeiliSearchCommunicationError(statusCode=%i) to a retryable 503 (no-store + Retry-After)',
    async (status) => {
      mockGetImagesFromFeedSearch.mockRejectedValue(makeCommunicationError(status));
      const { req, res } = createMocks({ query: { limit: '10' } });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(503);
      expect(res._getJSONData()).toEqual({
        error: 'Image search is temporarily overloaded — please retry.',
      });
      expect(res._getHeader('Cache-Control')).toBe('no-store');
      expect(res._getHeader('Retry-After')).toBe('2');
    }
  );

  // A MeiliSearchApiError carries a STRUCTURED JSON error body — for a 5xx that
  // is more likely a deterministic Meili-internal error than a transient
  // brownout, so ONLY the unambiguous gateway statuses 502/503/504 reclassify to
  // 503 (audit 🟡 #1). A JSON-body 408/429/500 ApiError is NOT masked.
  it.each([502, 503, 504])(
    'maps a MeiliSearchApiError(httpStatus=%i, gateway 5xx) to a retryable 503',
    async (status) => {
      mockGetImagesFromFeedSearch.mockRejectedValue(makeApiError(status));
      const { req, res } = createMocks({ query: { limit: '10' } });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(503);
      expect(res._getHeader('Cache-Control')).toBe('no-store');
      expect(res._getHeader('Retry-After')).toBe('2');
    }
  );

  it.each([408, 429])(
    'does NOT mask a MeiliSearchApiError(httpStatus=%i, JSON body) as 503 — only the Communication/transport path treats 408/429 as transient',
    async (status) => {
      mockGetImagesFromFeedSearch.mockRejectedValue(makeApiError(status));
      const { req, res } = createMocks({ query: { limit: '10' } });

      await handler(req, res);

      expect(res._getStatusCode()).not.toBe(503);
      expect(res._getHeader('Retry-After')).toBeUndefined();
    }
  );

  it('maps a MeiliSearchTimeOutError to a retryable 503', async () => {
    const e = new Error('timeout of 5000ms has exceeded ...') as Error & { name: string };
    e.name = 'MeiliSearchTimeOutError';
    mockGetImagesFromFeedSearch.mockRejectedValue(e);
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(503);
    expect(res._getHeader('Retry-After')).toBe('2');
  });

  it('maps a TRPCError SERVICE_UNAVAILABLE (the service-wrapped path) to 503 WITH no-store + Retry-After', async () => {
    const trpcError = Object.assign(new Error('Image search is temporarily overloaded — please retry.'), {
      code: 'SERVICE_UNAVAILABLE',
      name: 'TRPCError',
    });
    mockGetImagesFromFeedSearch.mockRejectedValue(trpcError);
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(503);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(res._getHeader('Retry-After')).toBe('2');
  });

  it('does NOT mask a TRPCError NOT_FOUND as 503 — keeps its real 404 (no Retry-After)', async () => {
    const notFound = Object.assign(new Error('Image not found'), {
      code: 'NOT_FOUND',
      name: 'TRPCError',
    });
    mockGetImagesFromFeedSearch.mockRejectedValue(notFound);
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
    const data = res._getJSONData();
    expect(data.code).toBe('NOT_FOUND');
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it.each([400, 401, 403])(
    'does NOT mask a non-transient upstream %i (real client/app error) as 503',
    async (status) => {
      // A 4xx-other from the SDK (e.g. malformed filter / auth) must surface as a
      // hard error, NOT a retryable 503. It isn't a TRPCError, so it falls to the
      // generic mapping → 500 (the correct "genuine failure must still surface"
      // behaviour). The key assertion: it is NOT 503 and carries NO Retry-After.
      mockGetImagesFromFeedSearch.mockRejectedValue(makeCommunicationError(status));
      const { req, res } = createMocks({ query: { limit: '10' } });

      await handler(req, res);

      expect(res._getStatusCode()).not.toBe(503);
      expect(res._getHeader('Retry-After')).toBeUndefined();
    }
  );

  it('does NOT mask a deterministic MeiliSearchApiError(httpStatus=500) (JSON body) as 503 — bubbles to 500, no Retry-After', async () => {
    // A structured-JSON Meili 500 is a deterministic Meili-internal error, NOT a
    // transient brownout — it must surface as a hard error, never a retryable
    // 503 (audit 🟡 #1 masking-guard). It isn't a TRPCError, so it falls to the
    // generic mapping → 500.
    mockGetImagesFromFeedSearch.mockRejectedValue(makeApiError(500));
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).not.toBe(503);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('DOES map a transport-layer MeiliSearchCommunicationError(statusCode=500) (empty body) to a retryable 503', async () => {
    // Contrast with the ApiError above: an empty/non-JSON-body 500 is the
    // genuinely-transient transport case → 503 with Retry-After.
    mockGetImagesFromFeedSearch.mockRejectedValue(makeCommunicationError(500));
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(503);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(res._getHeader('Retry-After')).toBe('2');
  });

  it('does NOT mask a generic app error (null deref) as 503 — bubbles to 500', async () => {
    mockGetImagesFromFeedSearch.mockRejectedValue(new Error('cannot read properties of undefined'));
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).not.toBe(503);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

  it('happy path is unchanged (200) with no Retry-After header', async () => {
    mockGetImagesFromFeedSearch.mockResolvedValue(mockImagesResult);
    const { req, res } = createMocks({ query: { limit: '10' } });

    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeader('Retry-After')).toBeUndefined();
  });

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
        stats: {},
        user: { username: 'forest919' },
        baseModel: 'Anima',
        modelVersionIds: [2653283],
        tags: [],
      },
    ],
    nextCursor: 'cursor_val',
  };
});
