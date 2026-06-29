import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pack, unpack } from 'msgpackr';
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
 *   (e) 404 (no model) is returned and is NOT cached (FIX 1: no negative cache)
 *   (f) bustPublicModelResponseCache forces the next call to rebuild (FIX 2)
 *   (g) msgpackr pack/unpack of a representative body preserves the public shape
 *
 * getModelsWithVersions is mocked so no Prisma is loaded. The redis client is
 * mocked with an in-memory store that round-trips through REAL msgpackr
 * pack/unpack (mirroring redis.packed) so the stored-wrapper shape is exercised,
 * not bypassed by a bare Map. withBlockScope is mocked to a passthrough that
 * stamps req.blockClaims (its real JWT-verify path is covered in
 * block-scope.middleware tests).
 */

const { mockGetModelsWithVersions } = vi.hoisted(() => ({
  mockGetModelsWithVersions: vi.fn(),
}));

// Per-test claims the mocked withBlockScope will stamp onto req (undefined = the
// pure-public path; an object = the block-scoped path that must bypass the cache).
const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

// In-memory Redis stand-in that round-trips values through REAL msgpackr
// pack/unpack — so the `{ data, cachedAt }` wrapper shape and msgpack
// serialization are exercised (not bypassed like a bare Map would). Stores the
// packed Buffer keyed by redis key; cleared in beforeEach.
const redisStore = new Map<string, Buffer>();
const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    packed: {
      get: vi.fn(),
      set: vi.fn(),
    },
    del: vi.fn(),
  },
}));

// fetchThroughCache is mocked with a faithful re-implementation of the real
// helper's relevant branches (read wrapper via redis.packed.get; on miss/expired,
// run fetchFn + redis.packed.set the `{ data, cachedAt }` wrapper). This keeps the
// store going through the SAME mocked redis the handler reads directly, so the
// positive-only write-through path is end-to-end consistent.
const { mockFetchThroughCache } = vi.hoisted(() => ({ mockFetchThroughCache: vi.fn() }));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
}));

// The handler imports publicModelResponseKey from model-version.service. Mock it
// to the SAME key scheme (avoids loading the heavy service graph). The real bust
// (bustPublicModelResponseCache) lives in that service and is unit-tested
// separately via redis.del; here we exercise the handler's read/write + a direct
// del to simulate a bust.
vi.mock('~/server/services/model-version.service', () => ({
  publicModelResponseKey: (id: number, browsingLevel: number) =>
    `packed:caches:public-model-response:${id}:${browsingLevel}`,
}));

vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: mockFetchThroughCache,
}));

vi.mock('~/server/redis/client', () => ({
  redis: redisMock,
  REDIS_KEYS: { CACHES: { PUBLIC_MODEL_RESPONSE: 'packed:caches:public-model-response' } },
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
    redisStore.clear();
    claimsBox.claims = undefined;
    regionBox.restricted = false;
    // Default model lookup returns one model.
    mockGetModelsWithVersions.mockImplementation(async ({ input }: any) => ({
      items: [modelItem(input.ids[0])],
    }));

    // redis.packed.get/set round-trip through REAL msgpackr (mirrors redis.packed).
    redisMock.packed.get.mockImplementation(async (key: string) => {
      const buf = redisStore.get(key);
      return buf ? unpack(buf) : null;
    });
    redisMock.packed.set.mockImplementation(async (key: string, value: unknown) => {
      redisStore.set(key, pack(value));
      return 'OK';
    });
    redisMock.del.mockImplementation(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      let n = 0;
      for (const k of keys) if (redisStore.delete(k)) n++;
      return n;
    });

    // Faithful fetchThroughCache: read the `{ data, cachedAt }` wrapper from the
    // mocked redis; on miss run fetchFn and store the wrapper. (The handler only
    // ever reaches fetchThroughCache on a confirmed miss with a positive body.)
    mockFetchThroughCache.mockImplementation(async (key: string, fetchFn: () => Promise<unknown>) => {
      const existing = await redisMock.packed.get(key);
      if (existing) return (existing as { data: unknown }).data;
      const data = await fetchFn();
      await redisMock.packed.set(key, { data, cachedAt: Date.now() });
      return data;
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
    expect(redisStore.size).toBe(1);
  });

  it('(b) cache HIT returns without re-running getModelsWithVersions', async () => {
    await invoke({ id: '123' }); // populate
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(1);

    const res = await invoke({ id: '123' }); // hit (served from redis.packed.get)
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
    // The cache was NEVER consulted — the block path builds directly.
    expect(redisMock.packed.get).not.toHaveBeenCalled();
    expect(mockFetchThroughCache).not.toHaveBeenCalled();
    expect(redisStore.size).toBe(0);
    // And it does not pollute the public cache: a subsequent public request misses.
    claimsBox.claims = undefined;
    await invoke({ id: '123' });
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(2); // block call + public miss
    expect(redisStore.size).toBe(1);
  });

  it('(d) cache key varies by browsingLevel (restricted vs not)', async () => {
    // Unrestricted region → allBrowsingLevelsFlag.
    await invoke({ id: '123' });
    // Restricted region → sfwBrowsingLevelsFlag → DIFFERENT key → separate miss.
    regionBox.restricted = true;
    await invoke({ id: '123' });

    const keys = [...redisStore.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.endsWith(`:123:${allBrowsingLevelsFlag}`))).toBe(true);
    expect(keys.some((k) => k.endsWith(`:123:${sfwBrowsingLevelsFlag}`))).toBe(true);
    // Two distinct keys → two pipeline runs (no cross-contamination).
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(2);
  });

  it('(e) missing model returns 404 and is NOT cached (no negative cache)', async () => {
    mockGetModelsWithVersions.mockResolvedValue({ items: [] });
    const res = await invoke({ id: '999' });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain('999');
    // FIX 1: the not-found result must NOT be written to the cache.
    expect(redisStore.size).toBe(0);
    expect(mockFetchThroughCache).not.toHaveBeenCalled(); // null short-circuits before write-through

    // A second call re-invokes the pipeline (re-builds) rather than serving a
    // cached 404 — so a just-published model can't be pinned to a stale 404.
    await invoke({ id: '999' });
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(2);
  });

  it('(f) busting the cache forces the next call to rebuild', async () => {
    await invoke({ id: '123' }); // populate
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(1);
    expect(redisStore.size).toBe(1);

    // Simulate bustPublicModelResponseCache: delete BOTH browsing-level keys for
    // the model (this is exactly what the service-side bust does via redis.del).
    await redisMock.del([
      `packed:caches:public-model-response:123:${allBrowsingLevelsFlag}`,
      `packed:caches:public-model-response:123:${sfwBrowsingLevelsFlag}`,
    ]);
    expect(redisStore.size).toBe(0);

    // Next request misses → rebuilds.
    const res = await invoke({ id: '123' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(123);
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(2);
  });

  it('(g) msgpackr pack/unpack preserves the public-API body shape', async () => {
    // A representative body with the field kinds the real response carries:
    // undefined (removeEmpty drops these), Date, nested objects, and arrays.
    const body = {
      id: 123,
      name: 'Model 123',
      mode: undefined as unknown as string | undefined,
      publishedAt: new Date('2026-01-02T03:04:05.000Z'),
      creator: { username: 'creator', image: null },
      tags: ['anime', 'style'],
      modelVersions: [
        {
          id: 1230,
          name: 'v1',
          files: [{ name: 'file.safetensors', primary: true, hashes: { SHA256: 'abc' } }],
          images: [{ url: 'img.png', type: 'image' }],
          trainedWords: [],
        },
      ],
    };

    const wrapper = { data: body, cachedAt: Date.now() };
    const roundTripped = unpack(pack(wrapper)) as { data: typeof body };

    // JSON.stringify parity pins the public-API shape: what the handler does on
    // the wire (res.json(body)) must be byte-identical after a Redis round-trip.
    // (JSON.stringify drops `undefined` and serializes Date via toJSON — so this
    // also asserts those edge cases survive the msgpack hop the same way.)
    expect(JSON.stringify(roundTripped.data)).toBe(JSON.stringify(body));
  });
});
