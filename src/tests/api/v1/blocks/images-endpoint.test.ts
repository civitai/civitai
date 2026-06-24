import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Endpoint-wiring security tests for /api/v1/blocks/images (the sibling of
 * /api/v1/blocks/models).
 *
 * These prove the handler delegates to runImageSearch with the CLAMPED browsing
 * level (never the client's), for green / blue / red / missing-claim tokens —
 * even when the client tries to pass nsfw=true / browsingLevel=31 (which the
 * schema doesn't accept, so they can't reach the search at all).
 *
 * withBlockScope is mocked as a passthrough that stamps req.blockClaims (the
 * real token-verify path is covered by block-scope.middleware tests). The image
 * search service is mocked so no Prisma/Meili/Flipt is loaded.
 */

const { mockRunImageSearch, mockCheckRateLimit } = vi.hoisted(() => ({
  mockRunImageSearch: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: mockRunImageSearch,
}));

// Per-token catalog rate limiter — mocked so the existing maturity-clamp tests
// are unaffected (default: allowed). Its own logic is covered in
// server/utils/__tests__/block-catalog-rate-limit.test.ts.
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockCheckRateLimit,
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
}));

vi.mock('@civitai/next-axiom', () => ({
  withAxiom: (handler: any) => handler,
}));

// Controllable region state — default unrestricted so existing tests are
// unaffected; flip `regionBox.restricted` per-test to exercise the geo clamp.
const regionBox = { restricted: false };
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({
    countryCode: regionBox.restricted ? 'GB' : 'US',
    regionCode: null,
    fullLocationCode: regionBox.restricted ? 'GB' : 'US',
  }),
  isRegionRestricted: () => regionBox.restricted,
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: () => ({ baseUrl: { origin: 'https://civitai.com' }, nextPage: undefined }),
  getPagination: () => ({ skip: 0 }),
}));

// Bulkhead: always grant a slot.
vi.mock('~/server/utils/request-bulkhead', () => ({
  acquireBulkheadSlot: () => () => {},
  BulkheadFullError: class extends Error {},
  HEAVY_REQUEST_CONCURRENCY: 10,
}));

function fakeClaims(over: Partial<BlockTokenClaims>): BlockTokenClaims {
  return {
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
    ctx: {},
    // No catalog:read (retired): the endpoint accepts ANY valid block token
    // (withBlockScope with no requiredScope). The handler never reads `scopes` —
    // its only authority is the maturity clamp on claims.maxBrowsingLevel.
    scopes: [],
    ...over,
  };
}

function fakeRes() {
  const res: Partial<NextApiResponse> & {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, unknown>;
    headersSent?: boolean;
  } = {
    headersSent: false,
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
    end() {
      return this as never;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any };
}

async function invoke(query: Record<string, unknown>) {
  const mod = await import('~/pages/api/v1/blocks/images');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: 'GET',
    query,
    headers: {},
    url: '/api/v1/blocks/images',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('/api/v1/blocks/images — authoritative clamp wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    mockRunImageSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    // Default: under the per-token ceiling (existing clamp tests must be served).
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('GREEN token + nsfw=true → search called with SFW level (clamped)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag, domain: 'green' });
    const res = await invoke({ nsfw: 'true', browsingLevel: '31' });

    expect(res.statusCode).toBe(200);
    expect(mockRunImageSearch).toHaveBeenCalledTimes(1);
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    // No mature bits leak.
    expect(ctx.browsingLevel & (4 | 8 | 16)).toBe(0);
    // The viewer is never threaded (catalog is public; clamp is the authority).
    expect(ctx.user).toBeUndefined();
  });

  it('BLUE token + browsingLevel=31 → still clamped to SFW', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag, domain: 'blue' });
    await invoke({ browsingLevel: '31', nsfw: 'true' });
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  it('RED token → unclamped (mature allowed)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: allBrowsingLevelsFlag, domain: 'red' });
    await invoke({});
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(allBrowsingLevelsFlag);
  });

  it('RED token from a RESTRICTED region → narrowed to SFW (geo clamp wiring)', async () => {
    regionBox.restricted = true;
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: allBrowsingLevelsFlag, domain: 'red' });
    await invoke({});
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    // Region restriction overrides the red ceiling down to SFW.
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(ctx.browsingLevel & (4 | 8 | 16)).toBe(0);
  });

  it('MISSING claim (legacy/pre-#2670 token) → fails closed to SFW', async () => {
    claimsBox.claims = fakeClaims({}); // no maxBrowsingLevel
    await invoke({ nsfw: 'true', browsingLevel: '31' });
    const [, ctx] = mockRunImageSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  it('client maturity fields are NEVER forwarded to the search input', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    await invoke({ nsfw: 'true', browsingLevel: '31', someJunk: 'x' });

    const [input] = mockRunImageSearch.mock.calls[0];
    // The schema strips unknown + maturity keys; the ...data rest carries none.
    expect(input.data).not.toHaveProperty('nsfw');
    expect(input.data).not.toHaveProperty('browsingLevel');
    expect(input.data).not.toHaveProperty('someJunk');
  });

  it('forwards the selector params (type/limit/sort/modelId/postId/username)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    await invoke({
      type: 'image',
      limit: '20',
      sort: 'Newest',
      modelId: '123',
      postId: '456',
      username: 'someone',
    });

    const [input] = mockRunImageSearch.mock.calls[0];
    expect(input.type).toBe('image');
    expect(input.limit).toBe(20);
    expect(input.data.sort).toBe('Newest');
    expect(input.data.modelId).toBe(123);
    expect(input.data.postId).toBe(456);
    expect(input.data.username).toBe('someone');
  });

  it('429s when paging past the offset cap (guard mirrors public endpoint)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const res = await invoke({ page: '11', limit: '100' });
    expect(res.statusCode).toBe(429);
    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });

  it('401s when no block claims were stamped (defense-in-depth; e.g. no token)', async () => {
    // The middleware (real) rejects anon before reaching here; this guards the
    // handler-internal `if (!claims) 401` path that fires if claims is absent.
    claimsBox.claims = undefined;
    const res = await invoke({});
    expect(res.statusCode).toBe(401);
    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });

  it('rejects non-GET', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const mod = await import('~/pages/api/v1/blocks/images');
    const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
    const req = { method: 'POST', query: {}, headers: {}, url: '/x' } as unknown as NextApiRequest;
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });

  it('over the per-token ceiling → 429 + Retry-After, search NOT called', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 6 });
    const res = await invoke({});

    expect(res.statusCode).toBe(429);
    expect((res as unknown as { headers: Record<string, unknown> }).headers['Retry-After']).toBe(
      '6'
    );
    // Keyed on the stable blockInstanceId from the claims.
    expect(mockCheckRateLimit).toHaveBeenCalledWith('bki_test');
    // The bulkhead slot + the expensive image search must be short-circuited.
    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });

  it('limiter redis failure is FAIL-OPEN — request is still served (200)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    // The helper itself catches redis errors and returns allowed:true; model
    // that here so the endpoint never 429/500s when the limiter's redis is down.
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true });
    const res = await invoke({});

    expect(res.statusCode).toBe(200);
    expect(mockRunImageSearch).toHaveBeenCalledTimes(1);
  });

  // ── Transient Meili → retryable 503 (audit 🟡 #2) ──────────────────────────
  // The sibling now uses the SAME isTransientMeiliError predicate the public
  // /api/v1/images handler uses, and attaches no-store + Retry-After: 2 so the
  // 503 carries the same retryable contract (the doc claims it mirrors the
  // public endpoint). isTransientMeiliError is NOT mocked here — the real
  // predicate runs.
  it('maps a transient Meili error to a retryable 503 (no-store + Retry-After)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    // meilisearch-js 0.33 MeiliSearchCommunicationError(503) shape — a transport
    // brownout the inner SDK throws, which used to bubble as a hard 500 here.
    const transient = new Error('Service Unavailable') as Error & {
      name: string;
      statusCode: number;
    };
    transient.name = 'MeiliSearchCommunicationError';
    transient.statusCode = 503;
    mockRunImageSearch.mockRejectedValueOnce(transient);

    const res = await invoke({});

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'Image search is temporarily overloaded — please retry.' });
    const headers = (res as unknown as { headers: Record<string, unknown> }).headers;
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Retry-After']).toBe('2');
  });

  it('a TRPCError SERVICE_UNAVAILABLE (service-wrapped) → 503 WITH no-store + Retry-After', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const trpcError = Object.assign(
      new Error('Image search is temporarily overloaded — please retry.'),
      { code: 'SERVICE_UNAVAILABLE', name: 'TRPCError' }
    );
    mockRunImageSearch.mockRejectedValueOnce(trpcError);

    const res = await invoke({});

    expect(res.statusCode).toBe(503);
    const headers = (res as unknown as { headers: Record<string, unknown> }).headers;
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Retry-After']).toBe('2');
  });

  it('does NOT mask a deterministic ApiError 500 (JSON body) as 503 — surfaces a non-503 status, no Retry-After', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    // Structured-JSON Meili 500 → deterministic, must NOT be reclassified.
    const apiError500 = new Error('internal') as Error & { name: string; httpStatus: number };
    apiError500.name = 'MeiliSearchApiError';
    apiError500.httpStatus = 500;
    mockRunImageSearch.mockRejectedValueOnce(apiError500);

    const res = await invoke({});

    expect(res.statusCode).not.toBe(503);
    const headers = (res as unknown as { headers: Record<string, unknown> }).headers;
    expect(headers['Retry-After']).toBeUndefined();
  });
});
