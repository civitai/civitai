import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Out-of-range model/version id → 400 (not raw 500) validation.
 *
 * ROOT CAUSE: `z.coerce.number()` coerces an arbitrarily large numeric string
 * (bot/scraper garbage like `853267723675816615`, `999999999999`) to a JS float
 * and `.number()` ACCEPTS it, so safeParse SUCCEEDS. The id then binds to the
 * Postgres `Model.id` / `ModelVersion.id` column (int4, max 2147483647) and PG
 * throws "value out of range for type integer" → a raw 500 (invisible in Axiom,
 * ~81/12h live). Bounding the schema to int4 makes the out-of-range id fail
 * safeParse → the handlers' EXISTING 400 path fires instead.
 *
 * These tests pin the schema directly (fail-before/pass-after the `.int().gt(0)
 * .lte(2147483647)` bound) for BOTH the models/[id] handler and its identical
 * sibling model-versions/mini/[id], plus a handler-level check that a valid but
 * NONEXISTENT in-range id still returns 404 (not 400) — i.e. the bound doesn't
 * over-tighten valid ids into 400s.
 *
 * The page modules pull heavy service/db/redis graphs at import time, so those
 * are mocked to passthroughs/no-ops; the schemas under test are the REAL
 * (un-mocked) zod objects the modules export.
 */

const INT4_MAX = 2147483647;

// --- models/[id] handler graph ---
const { mockGetModelsWithVersions } = vi.hoisted(() => ({ mockGetModelsWithVersions: vi.fn() }));

vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: mockGetModelsWithVersions,
  getFeaturedModels: vi.fn(async () => []),
}));
vi.mock('~/server/services/model-version.service', () => ({
  publicModelResponseKey: (id: number, browsingLevel: number) =>
    `packed:caches:public-model-response:${id}:${browsingLevel}`,
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  // IS_DATAPACKET is false below → the handler takes the direct-build branch and
  // never touches this, but it must resolve at import time.
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/server/redis/client', () => ({
  redis: { packed: { get: vi.fn(), set: vi.fn() }, del: vi.fn() },
  REDIS_KEYS: { CACHES: { PUBLIC_MODEL_RESPONSE: 'packed:caches:public-model-response' } },
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = undefined; // pure-public path
    return handler(req, res);
  },
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/services/file.service', () => ({ getDownloadFilename: () => 'file.safetensors' }));

// --- shared / mini/[id] handler graph ---
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: any) => (req: any, res: any) => handler(req, res),
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, undefined),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));
vi.mock('~/server/utils/url-helpers', () => ({ getBaseUrl: () => 'https://civitai.com' }));
vi.mock('~/server/common/model-helpers', () => ({ createModelFileDownloadUrl: () => '/download' }));
vi.mock('~/server/utils/model-helpers', () => ({
  getPrimaryFile: (files: any[]) => files?.[0],
  getEpochJobAndFileName: () => ({}),
}));
vi.mock('~/server/db/client', () => ({ dbWrite: { $queryRaw: vi.fn(async () => []) } }));
vi.mock('~/server/services/generation/generation.service', () => ({
  getShouldChargeForResources: vi.fn(async () => ({})),
  resolveCanGenerateForVersions: vi.fn(async () => []),
}));
vi.mock('~/env/server', () => ({
  // IS_DATAPACKET false → models/[id] skips the redis cache and builds directly.
  env: { IS_DATAPACKET: false, LOGGING: '', IS_BUILD: true },
}));

// The REAL exported schemas (only the service/db graph around them is mocked).
import { schema as modelsSchema } from '~/pages/api/v1/models/[id]';
import { schema as miniSchema } from '~/pages/api/v1/model-versions/mini/[id]';

// Out-of-range / invalid ids that a bare z.coerce.number() would WRONGLY accept.
const OUT_OF_RANGE = ['853267723675816615', '999999999999', '308615308615', String(INT4_MAX + 1)];
const NON_POSITIVE = ['0', '-5'];
const NON_INTEGER = ['12.5', 'abc'];
// Real, in-range ids that MUST still pass.
const VALID = ['2686725', '1', String(INT4_MAX)];

describe.each([
  ['models/[id]', modelsSchema],
  ['model-versions/mini/[id]', miniSchema],
])('%s schema — int4 id bound', (_name, schema) => {
  it.each(OUT_OF_RANGE)('rejects out-of-range id %s (was raw 500 via int4 overflow)', (id) => {
    // FAIL-BEFORE: with a bare z.coerce.number() this safeParse SUCCEEDS.
    expect(schema.safeParse({ id }).success).toBe(false);
  });

  it.each(NON_POSITIVE)('rejects non-positive id %s', (id) => {
    expect(schema.safeParse({ id }).success).toBe(false);
  });

  it.each(NON_INTEGER)('rejects non-integer id %s', (id) => {
    expect(schema.safeParse({ id }).success).toBe(false);
  });

  it.each(VALID)('accepts valid in-range id %s and coerces to a number', (id) => {
    const parsed = schema.safeParse({ id });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toBe(Number(id));
  });
});

// ---------------------------------------------------------------------------
// Handler-level guard: the bound must not over-tighten a VALID-but-nonexistent
// in-range id into a 400 — it must still reach the 404 path.
// ---------------------------------------------------------------------------
function fakeRes() {
  const res: Partial<NextApiResponse> & { statusCode?: number; body?: any } = {
    setHeader() {
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

async function invokeModels(id: string) {
  const mod = await import('~/pages/api/v1/models/[id]');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: 'GET',
    query: { id },
    headers: { host: 'civitai.com' },
    url: `/api/v1/models/${id}`,
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('GET /api/v1/models/[id] — 400 vs 404 vs 200 behavior', () => {
  beforeEach(() => vi.clearAllMocks());

  it('out-of-range id → 400 (existing bad-id path), never reaches the DB', async () => {
    const res = await invokeModels('853267723675816615');
    expect(res.statusCode).toBe(400);
    // The overflow id is rejected at safeParse, BEFORE the model lookup.
    expect(mockGetModelsWithVersions).not.toHaveBeenCalled();
  });

  it('valid-but-nonexistent in-range id → 404 (NOT over-tightened to 400)', async () => {
    mockGetModelsWithVersions.mockResolvedValue({ items: [] });
    const res = await invokeModels('2147000000'); // in-range, no such model
    expect(res.statusCode).toBe(404);
    expect(mockGetModelsWithVersions).toHaveBeenCalledTimes(1);
  });

  it('valid existing id → 200', async () => {
    mockGetModelsWithVersions.mockResolvedValue({
      items: [
        {
          id: 2686725,
          name: 'Model',
          mode: null,
          tagsOnModels: [],
          user: { username: 'creator', image: null, profilePicture: null },
          modelVersions: [],
        },
      ],
    });
    const res = await invokeModels('2686725');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(2686725);
  });
});
