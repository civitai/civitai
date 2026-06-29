import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Origin-side response cache tests for GET /api/v1/models/[id].
 *
 * Cloudflare already edge-caches this endpoint (PublicEndpoint sets
 * s-maxage=300). This origin cache (TTL=180s ≤ edge TTL) spares the
 * getModelsWithVersions pipeline on edge-MISSES. These tests pin:
 *   (a) cache MISS populates and returns the correct body
 *   (b) cache HIT returns WITHOUT calling getModelsWithVersions again
 *   (c) the block-scoped (block-JWT) path BYPASSES the cache entirely
 *   (d) the cache key varies by browsingLevel (restricted vs not)
 *   (e) 404 (no model) is returned (negative-cached)
 *
 * getModelsWithVersions and fetchThroughCache are mocked so no Prisma/Redis is
 * loaded; withBlockScope is mocked to a passthrough that stamps req.blockClaims
 * (its real JWT-verify path is covered in block-scope.middleware tests).
 */

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

// Per-test claims the mocked withBlockScope will stamp onto req (undefined = the
// pure-public path; an object = the block-scoped path that must bypass the cache).
const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

// In-memory stand-in for fetchThroughCache: real packing/Redis is irrelevant to
// the caching CONTRACT (miss → fetchFn + store; hit → no fetchFn). The store
// persists across invocations within a test; cleared in beforeEach.
const cacheStore = new Map<string, unknown>();
const { mockFetchThroughCache } = vi.hoisted(() => ({ mockFetchThroughCache: vi.fn() }));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));

vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: mockFetchThroughCache,
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  // Passthrough public endpoint: no CORS/cache headers needed for these tests.
  PublicEndpoint: (handler: any) => (req: any, res: any) => handler(req, res),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

const regionBox = { restricted: false };
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => (regionBox.restricted ? 'GB' : 'US'),
  isRegionRestricted: () => regionBox.restricted,
}));

// IS_DATAPACKET drives the cache-on switch in the handler. LOGGING/IS_BUILD are
// read transitively by ~/server/redis/client (createLogger + the build guard)
// when the handler imports REDIS_KEYS from it.
vi.mock('~/env/server', () => ({
  env: { IS_DATAPACKET: true, LOGGING: '', IS_BUILD: true },
}));

// Trim the serialization helper graph so the handler body is deterministic and
// no Prisma client loads through them.
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/common/model-helpers', () => ({
  createModelFileDownloadUrl: () => '/download',
}));
vi.mock('~/server/services/file.service', () => ({ getDownloadFilename: () => 'file.safetensors' }));
vi.mock('~/server/utils/model-helpers', () => ({ getPrimaryFile: (files: any[]) => files[0] }));
vi.mock('~/server/utils/url-helpers', () => ({ getBaseUrl: () => 'https://civitai.com' }));

function modelItem(id: number) {
  return {
    id,
    name: `Model ${id}`,
    mode: null,
    tagsOnModels: [{ name: 'anime' }],
    user: { username: 'creator', image: 'avatar.png', profilePicture: null },
    modelVersions: [
      {
        id: id * 10,
        name: 'v1',
        status: 'Published',
        files: [
          {
            id: 1,
            type: 'Model',
            visibility: 'Public',
            hashes: [{ type: 'SHA256', hash: 'abc' }],
            metadata: {},
          },
        ],
        images: [{ id: 99, url: 'img.png', type: 'image' }],
      },
    ],
  };
}

function fakeRes() {
  const res: Partial<NextApiResponse> & {
    statusCode?: number;
    body?: any;
    headers: Record<string, unknown>;
  } = {
    headers: {},
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
      return this as never;
    },
    status(code: number) {
      this.statusCode = code;
      return this as never;
    },
    json(b: unknown) {
      this.body = b;
      return this as never;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any };
}

async function invoke(query: Record<string, unknown>) {
  const mod = await import('~/pages/api/v1/models/[id]');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: 'GET',
    query,
    headers: { host: 'civitai.com' },
    url: `/api/v1/models/${query.id}`,
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('GET /api/v1/models/[id] — origin-side response cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    claimsBox.claims = undefined;
    regionBox.restricted = false;
    // Default model lookup returns one model.
    mockGetModelsWithVersions.mockImplementation(async ({ input }: any) => ({
      items: [modelItem(input.ids[0])],
    }));
    // Real-shaped fetchThroughCache: serve store hit, else run + store fetchFn.
    mockFetchThroughCache.mockImplementation(async (key: string, fetchFn: () => Promise<unknown>) => {
      if (cacheStore.has(key)) return cacheStore.get(key);
      const value = await fetchFn();
      cacheStore.set(key, value);
      return value;
    });
  });

  it('(a) cache MISS populates and returns the correct body', async () => {
    const res = await invoke({ id: '123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(123);
    expect(res.body.creator.username).toBe('creator');
    expect(res.body.tags).toEqual(['anime']);
    // The pipeline ran exactly once and the cache was populated.
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(1);
    expect(mockFetchThroughCache).toHaveBeenCalledTimes(1);
    expect(cacheStore.size).toBe(1);
  });

  it('(b) cache HIT returns without re-running getModelsWithVersions', async () => {
    await invoke({ id: '123' }); // populate
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(1);

    const res = await invoke({ id: '123' }); // hit
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(123);
    // Still only ONE pipeline call total — the second request served from cache.
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(1);
  });

  it('(c) block-scoped (block-JWT) path BYPASSES the cache', async () => {
    claimsBox.claims = {
      iss: 'civitai',
      aud: 'civitai-app-block',
      sub: 'user:42',
      iat: 0,
      exp: 0,
      jti: 'jti',
      blockId: 'blk',
      appId: 'app',
      appBlockId: 'apb_test',
      blockInstanceId: 'bki_test',
      ctx: { modelId: 123 },
      scopes: ['models:read:self'],
    };
    const res = await invoke({ id: '123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(123);
    // The cache helper was NEVER consulted — the block path builds directly.
    expect(mockFetchThroughCache).not.toHaveBeenCalled();
    expect(cacheStore.size).toBe(0);
    // And it does not pollute the public cache: a subsequent public request misses.
    claimsBox.claims = undefined;
    await invoke({ id: '123' });
    expect(mockFetchThroughCache).toHaveBeenCalledTimes(1);
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(2); // block call + public miss
  });

  it('(d) cache key varies by browsingLevel (restricted vs not)', async () => {
    // Unrestricted region → allBrowsingLevelsFlag.
    await invoke({ id: '123' });
    // Restricted region → sfwBrowsingLevelsFlag → DIFFERENT key → separate miss.
    regionBox.restricted = true;
    await invoke({ id: '123' });

    const keys = mockFetchThroughCache.mock.calls.map((c) => c[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain(`:123:${allBrowsingLevelsFlag}`);
    expect(keys[1]).toContain(`:123:${sfwBrowsingLevelsFlag}`);
    expect(keys[0]).not.toBe(keys[1]);
    // Two distinct keys → two pipeline runs (no cross-contamination).
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(2);
    expect(cacheStore.size).toBe(2);
  });

  it('(e) missing model returns 404', async () => {
    mockGetModelsWithVersions.mockResolvedValue({ items: [] });
    const res = await invoke({ id: '999' });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain('999');
  });
});
