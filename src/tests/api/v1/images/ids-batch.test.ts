import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * `GET /api/v1/images?ids=1,2,3` — batch by id.
 *
 * The retired `GET_IMAGES_BY_IDS` bridge message was batch by construction; its
 * REST replacement took a single `imageId`, so a grid-shaped app turned one call
 * into N calls against a rate-limited public API
 * (civitai/civitai-app-starters#429).
 *
 * Route-level coverage: the schema accepts the param, enforces the inherited
 * cap, and the request lands on the DB path with the filter intact. The routing
 * defect itself is pinned one layer down, where it lives, in
 * `src/server/services/__tests__/image-search-ids-db-path.test.ts`.
 */

const {
  mockGetAllImages,
  mockGetImagesFromFeedSearch,
  mockImageMetaCacheFetch,
  mockGetServerAuthSession,
  mockGetFeatureFlags,
} = vi.hoisted(() => ({
  mockGetAllImages: vi.fn(),
  mockGetImagesFromFeedSearch: vi.fn(),
  mockImageMetaCacheFetch: vi.fn(),
  mockGetServerAuthSession: vi.fn(),
  mockGetFeatureFlags: vi.fn(),
}));

vi.mock('~/server/services/image.service', () => ({
  getAllImages: mockGetAllImages,
  getImagesFromFeedSearch: mockGetImagesFromFeedSearch,
}));
vi.mock('~/server/redis/caches', () => ({
  imageMetaCache: { fetch: mockImageMetaCacheFetch },
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: mockGetFeatureFlags,
  buildFliptContext: vi.fn(),
}));
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (url: string) => `https://cf-images.com/${url}`,
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: vi.fn().mockReturnValue('US'),
  isRegionRestricted: vi.fn().mockReturnValue(false),
}));
// Only the two symbols the route + the search service actually reach for. The
// sibling index.test.ts spreads the real module because it exercises the
// transient-error classification; nothing here throws, so a stub keeps Meili's
// module-load (env + prom collectors) out of this file entirely.
vi.mock('~/server/meilisearch/client', () => ({
  buildSearchActor: vi.fn().mockReturnValue('mock-actor'),
  isTransientMeiliError: vi.fn().mockReturnValue(false),
}));
vi.mock('request-ip', () => ({ default: { getClientIp: () => '127.0.0.1' } }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: any) => handler,
}));

import handler from '~/pages/api/v1/images/index';
import { IMAGE_IDS_BATCH_MAX } from '~/server/common/constants';

function createMocks({ query = {} }: { query?: Record<string, string | string[]> }) {
  const req = { method: 'GET', headers: {}, query } as unknown as NextApiRequest;

  let statusCode = 200;
  let payload: any = undefined;
  const headers: Record<string, string> = {};

  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
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
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => any;
  };

  return { req, res };
}

function image(id: number) {
  return {
    id,
    url: `uuid-${id}`,
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
  };
}

const IDS = [140383933, 140383934, 140383935];

describe('/api/v1/images?ids= — batch by id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerAuthSession.mockResolvedValue(null);
    mockGetFeatureFlags.mockReturnValue({ datapacketRead: false, canViewNsfw: false });
    mockImageMetaCacheFetch.mockResolvedValue({});
    mockGetAllImages.mockResolvedValue({ items: IDS.map(image), nextCursor: undefined });
    // The impostor: what the global feed would answer with if `ids` ever routed
    // there. Same shape, same length, different ids.
    mockGetImagesFromFeedSearch.mockResolvedValue({
      items: [12097475, 12097476, 12097477].map(image),
      nextCursor: undefined,
    });
  });

  it('accepts a comma-delimited batch and answers with those ids', async () => {
    const { req, res } = createMocks({ query: { ids: IDS.join(',') } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // 🔴 The IDS, not the count — the feed impostor above has the same length.
    expect(res._getJSONData().items.map((i: { id: number }) => i.id)).toEqual(IDS);
    expect(mockGetAllImages).toHaveBeenCalledWith(expect.objectContaining({ ids: IDS }));
    expect(mockGetImagesFromFeedSearch).not.toHaveBeenCalled();
  });

  it('a single id through ?ids= behaves like the existing ?imageId=', async () => {
    mockGetAllImages.mockResolvedValue({ items: [image(IDS[0])], nextCursor: undefined });
    const { req, res } = createMocks({ query: { ids: String(IDS[0]) } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().items.map((i: { id: number }) => i.id)).toEqual([IDS[0]]);
    expect(mockGetAllImages).toHaveBeenCalledWith(expect.objectContaining({ ids: [IDS[0]] }));
  });

  it('INVARIANT: ?imageId= alone is unchanged by the widening', async () => {
    mockGetAllImages.mockResolvedValue({ items: [image(100)], nextCursor: undefined });
    const { req, res } = createMocks({ query: { imageId: '100' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().items.map((i: { id: number }) => i.id)).toEqual([100]);
    expect(mockGetAllImages).toHaveBeenCalledWith(expect.objectContaining({ imageId: 100 }));
    expect(mockGetImagesFromFeedSearch).not.toHaveBeenCalled();
  });

  it('INVARIANT: a request with no ids still reaches feed search', async () => {
    const { req, res } = createMocks({ query: { limit: '10' } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetImagesFromFeedSearch).toHaveBeenCalledTimes(1);
    expect(mockGetAllImages).not.toHaveBeenCalled();
  });

  // ── The cap ────────────────────────────────────────────────────────────────

  it(`accepts exactly ${IMAGE_IDS_BATCH_MAX} ids`, async () => {
    const many = Array.from({ length: IMAGE_IDS_BATCH_MAX }, (_, i) => i + 1);
    mockGetAllImages.mockResolvedValue({ items: many.map(image), nextCursor: undefined });
    const { req, res } = createMocks({ query: { ids: many.join(',') } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetAllImages).toHaveBeenCalledWith(expect.objectContaining({ ids: many }));
  });

  it(`rejects ${
    IMAGE_IDS_BATCH_MAX + 1
  } ids with a 400, without touching either search`, async () => {
    const many = Array.from({ length: IMAGE_IDS_BATCH_MAX + 1 }, (_, i) => i + 1);
    const { req, res } = createMocks({ query: { ids: many.join(',') } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockGetAllImages).not.toHaveBeenCalled();
    expect(mockGetImagesFromFeedSearch).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '1.5'],
    ['a bad entry among good ones', `${IDS[0]},abc`],
  ])('rejects a %s ids param with 400 (never a silent unfiltered feed)', async (_label, raw) => {
    const { req, res } = createMocks({ query: { ids: raw } });
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockGetAllImages).not.toHaveBeenCalled();
    expect(mockGetImagesFromFeedSearch).not.toHaveBeenCalled();
  });

  // ── Misses are reported by OMISSION, on purpose ────────────────────────────
  //
  // See the contract note above `handleImagesRequest`. An id the viewer may not
  // see and an id that does not exist must be INDISTINGUISHABLE, so the response
  // may not carry a "these were missing" list — that list is exactly the
  // enumeration `BlockGatedImage` refuses to emit one layer over.

  it('returns a SHORTER array for unresolvable ids, and names none of them', async () => {
    mockGetAllImages.mockResolvedValue({ items: [image(IDS[0])], nextCursor: undefined });
    const { req, res } = createMocks({ query: { ids: IDS.join(',') } });
    await handler(req, res);

    const data = res._getJSONData();
    expect(res._getStatusCode()).toBe(200);
    expect(data.items.map((i: { id: number }) => i.id)).toEqual([IDS[0]]);

    // 🔴 Pin the WHOLE response, not the absence of one field name a future
    // change could spell differently. The two ids that did not come back must
    // appear NOWHERE in the body.
    expect(Object.keys(data).sort()).toEqual(['items', 'metadata']);
    const body = JSON.stringify(data);
    for (const missing of IDS.slice(1)) expect(body).not.toContain(String(missing));
    // Control for that assertion: the id that WAS returned is present, so
    // `not.toContain` is measuring something.
    expect(body).toContain(String(IDS[0]));

    // And the metadata envelope stays the paging envelope. A later
    // `notFoundIds`/`missing`/`resolved` key goes red HERE, which is the point:
    // re-opening the disclosure should take a deliberate edit to this file, not
    // an unnoticed field.
    expect(Object.keys(data.metadata).sort()).toEqual(['nextCursor', 'nextPage']);
  });
});
