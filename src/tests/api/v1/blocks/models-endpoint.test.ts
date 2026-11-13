import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';

/**
 * Endpoint-wiring security tests for /api/v1/blocks/models.
 *
 * These prove the handler delegates to runModelSearch with the CLAMPED
 * browsing level (never the client's) and with nsfwImagePassthrough:false, for
 * green / blue / red / missing-claim tokens — even when the client sends
 * nsfw=true / browsingLevel=31.
 *
 * withBlockScope is mocked as a passthrough that stamps req.blockClaims (the
 * real token-verify path is covered by block-scope.middleware tests). The model
 * service is mocked so no Prisma client is loaded.
 */

const { mockRunModelSearch, mockResolveModelSearchIds, mockCheckRateLimit } = vi.hoisted(() => ({
  mockRunModelSearch: vi.fn(),
  mockResolveModelSearchIds: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

// Holds the claims the mocked withBlockScope will stamp onto req for the
// current test. Set per-test before invoking the handler.
const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/services/model-search.service', () => ({
  runModelSearch: mockRunModelSearch,
  resolveModelSearchIds: mockResolveModelSearchIds,
  ModelSearchMeiliTimeoutError: class extends Error {},
}));

// Per-token catalog rate limiter — mocked so the existing maturity-clamp tests
// are unaffected (default: allowed). Its own logic is covered in
// server/utils/__tests__/block-catalog-rate-limit.test.ts.
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockCheckRateLimit,
}));

vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  // The REAL parseSubjectUserId (owner=mine derives the user id from it), so a
  // change to how `sub` is parsed reaches these tests.
  ...(await importOriginal<typeof BlockScopeMiddleware>()),
  // Passthrough wrapper: stamp the per-test claims and call the handler. Bypasses
  // JWT verify (covered elsewhere) so we can assert the clamp wiring directly.
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

vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: () => ({ baseUrl: { origin: 'https://civitai.com' }, nextPage: undefined }),
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
  // Import after mocks are registered.
  const mod = await import('~/pages/api/v1/blocks/models');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method: 'GET',
    query,
    headers: {},
    url: '/api/v1/blocks/models',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('/api/v1/blocks/models — authoritative clamp wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    // Default: under the per-token ceiling (existing clamp tests must be served).
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('GREEN token + nsfw=true → search called with SFW level (clamped), passthrough false', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag, domain: 'green' });
    const res = await invoke({ nsfw: 'true', browsingLevel: '31' });

    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch).toHaveBeenCalledTimes(1);
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(false);
    // No mature bits leak.
    expect(ctx.browsingLevel & (4 | 8 | 16)).toBe(0);
    expect(res.body.maturity).toEqual({ browsingLevel: sfwBrowsingLevelsFlag, sfwOnly: true });
  });

  it('BLUE token + browsingLevel=31 → still clamped to SFW (blue is SFW for blocks)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag, domain: 'blue' });
    const res = await invoke({ browsingLevel: '31', nsfw: 'true' });

    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(false);
    expect(res.body.maturity.sfwOnly).toBe(true);
  });

  it('RED token → unclamped (mature allowed)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: allBrowsingLevelsFlag, domain: 'red' });
    const res = await invoke({});

    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(allBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(false); // never passthrough — filter by level
    expect(res.body.maturity.sfwOnly).toBe(false);
  });

  it('RED token from a RESTRICTED region → narrowed to SFW (geo clamp wiring)', async () => {
    regionBox.restricted = true;
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: allBrowsingLevelsFlag, domain: 'red' });
    const res = await invoke({});

    const [, ctx] = mockRunModelSearch.mock.calls[0];
    // Region restriction overrides the red ceiling down to SFW.
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(ctx.browsingLevel & (4 | 8 | 16)).toBe(0);
    expect(res.body.maturity).toEqual({ browsingLevel: sfwBrowsingLevelsFlag, sfwOnly: true });
    // The Meili pre-step is clamped too — assert via a query so it's invoked.
  });

  it('MISSING claim (legacy/pre-#2670 token) → fails closed to SFW', async () => {
    claimsBox.claims = fakeClaims({}); // no maxBrowsingLevel
    const res = await invoke({ nsfw: 'true', browsingLevel: '31' });

    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(res.body.maturity.sfwOnly).toBe(true);
  });

  it('client maturity fields are NEVER forwarded to the search input', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    await invoke({ nsfw: 'true', browsingLevel: '31', someJunk: 'x' });

    const [input] = mockRunModelSearch.mock.calls[0];
    // The handler builds an explicit allowlist of params; no nsfw/browsingLevel
    // key is on the search input object.
    expect(input).not.toHaveProperty('nsfw');
    expect(input).not.toHaveProperty('browsingLevel');
    expect(input).not.toHaveProperty('someJunk');
  });

  it('forces disableMinor on the search input, even under a SFW ceiling', async () => {
    // The public endpoint lets the addon policy decide, and that rule only fires
    // above R — so a SFW-clamped block would otherwise start listing minor models.
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag, domain: 'green' });
    await invoke({});

    const [input] = mockRunModelSearch.mock.calls[0];
    expect(input.disableMinor).toBe(true);
  });

  it('forwards the selector params (query/types/baseModels/sort/limit)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    await invoke({
      query: 'dreamshaper',
      types: 'Checkpoint',
      baseModels: 'SDXL 1.0',
      sort: 'Most Downloaded',
      limit: '20',
      supportsGeneration: 'true',
    });

    const [input] = mockRunModelSearch.mock.calls[0];
    expect(input.query).toBe('dreamshaper');
    expect(input.types).toEqual(['Checkpoint']);
    expect(input.baseModels).toEqual(['SDXL 1.0']);
    expect(input.limit).toBe(20);
    // The Meili pre-step must be called with the CLAMPED level too, and the
    // type filter must reach it (filtering only post-Meili in the DB returns
    // empty pages for sparse types like Wildcards).
    expect(mockResolveModelSearchIds).toHaveBeenCalledTimes(1);
    expect(mockResolveModelSearchIds.mock.calls[0][0].browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(mockResolveModelSearchIds.mock.calls[0][0].types).toEqual(['Checkpoint']);
    expect(mockResolveModelSearchIds.mock.calls[0][0].baseModels).toEqual(['SDXL 1.0']);
    expect(mockResolveModelSearchIds.mock.calls[0][0].supportsGeneration).toBe(true);
  });

  it('401s when no block claims were stamped (defense-in-depth; e.g. no token)', async () => {
    // The middleware (real) rejects anon before reaching here; this guards the
    // handler-internal `if (!claims) 401` path that fires if claims is absent.
    claimsBox.claims = undefined;
    const res = await invoke({});
    expect(res.statusCode).toBe(401);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('rejects non-GET', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const mod = await import('~/pages/api/v1/blocks/models');
    const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
    const req = { method: 'POST', query: {}, headers: {}, url: '/x' } as unknown as NextApiRequest;
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('over the per-token ceiling → 429 + Retry-After, search NOT called', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 6 });
    const res = await invoke({ query: 'dreamshaper' });

    expect(res.statusCode).toBe(429);
    expect((res as unknown as { headers: Record<string, unknown> }).headers['Retry-After']).toBe(
      '6'
    );
    // Keyed on the stable blockInstanceId from the claims.
    expect(mockCheckRateLimit).toHaveBeenCalledWith('bki_test');
    // The expensive search (and its Meili pre-step) must be short-circuited.
    expect(mockRunModelSearch).not.toHaveBeenCalled();
    expect(mockResolveModelSearchIds).not.toHaveBeenCalled();
  });

  it('limiter redis failure is FAIL-OPEN — request is still served (200)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    // The helper itself catches redis errors and returns allowed:true; model
    // that here so the endpoint never 429/500s when the limiter's redis is down.
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true });
    const res = await invoke({});

    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch).toHaveBeenCalledTimes(1);
  });
});

// Distinct from each other and from every literal elsewhere in this file (42 is
// fakeClaims' default subject), so a handler that hardcodes or swaps an id is seen.
const SUBJECT_ID = 7311;
const OTHER_ID = 5529;

describe('/api/v1/blocks/models — owner filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('owner=mine scopes the search to the token subject', async () => {
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
    const res = await invoke({ owner: 'mine', query: 'dreamshaper' });

    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch.mock.calls[0][1].ownerUserId).toBe(SUBJECT_ID);
    expect(mockResolveModelSearchIds.mock.calls[0][0].ownerUserId).toBe(SUBJECT_ID);
  });

  it('owner absent or owner=any applies no owner constraint', async () => {
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
    for (const query of [{ query: 'x' }, { query: 'x', owner: 'any' }]) {
      vi.clearAllMocks();
      mockCheckRateLimit.mockResolvedValue({ allowed: true });
      mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
      mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
      const res = await invoke(query);
      expect(res.statusCode).toBe(200);
      expect(mockRunModelSearch.mock.calls[0][1].ownerUserId).toBeUndefined();
      expect(mockResolveModelSearchIds.mock.calls[0][0].ownerUserId).toBeUndefined();
    }
  });

  it('A2: owner=mine with an anonymous subject → 401, nothing searched', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' });
    const res = await invoke({ owner: 'mine', query: 'x' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Sign-in required' });
    expect(mockRunModelSearch).not.toHaveBeenCalled();
    expect(mockResolveModelSearchIds).not.toHaveBeenCalled();
    // Refused before the rate limiter is charged.
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('owner=mine with a malformed subject → 403, nothing searched', async () => {
    for (const sub of ['user:abc', 'garbage', `user:${SUBJECT_ID}x`]) {
      claimsBox.claims = fakeClaims({ sub });
      const res = await invoke({ owner: 'mine', query: 'x' });
      expect(res.statusCode, sub).toBe(403);
      expect(res.body).toEqual({ error: 'Invalid subject claim' });
    }
    expect(mockRunModelSearch).not.toHaveBeenCalled();
    expect(mockResolveModelSearchIds).not.toHaveBeenCalled();
  });

  it('an anonymous subject is still served the unscoped catalog (owner=any unchanged)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' });
    const res = await invoke({});
    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch.mock.calls[0][1].ownerUserId).toBeUndefined();
  });

  it('A6: owner=mine ignores a userId / username supplied in the query', async () => {
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
    const res = await invoke({
      owner: 'mine',
      query: 'x',
      userId: String(OTHER_ID),
      ownerUserId: String(OTHER_ID),
      username: 'someone-else',
      user: 'someone-else',
    });

    expect(res.statusCode).toBe(200);
    const [input, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.ownerUserId).toBe(SUBJECT_ID);
    expect(mockResolveModelSearchIds.mock.calls[0][0].ownerUserId).toBe(SUBJECT_ID);
    for (const key of ['userId', 'ownerUserId', 'username', 'user']) {
      expect(input).not.toHaveProperty(key);
    }
  });

  // Invariant guard: green before this change too (the schema strips unknown keys).
  it('A6 (invariant guard): owner=any ignores a userId supplied in the query', async () => {
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
    await invoke({ query: 'x', userId: String(OTHER_ID), ownerUserId: String(OTHER_ID) });

    const [input, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.ownerUserId).toBeUndefined();
    expect(mockResolveModelSearchIds.mock.calls[0][0].ownerUserId).toBeUndefined();
    expect(input).not.toHaveProperty('userId');
    expect(input).not.toHaveProperty('ownerUserId');
  });

  it('rejects an unknown owner value with 400', async () => {
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
    for (const owner of ['me', String(OTHER_ID), ['mine', 'any']]) {
      const res = await invoke({ owner });
      expect(res.statusCode).toBe(400);
    }
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  // Invariant guard: the clamp logic is untouched by this change; this pins that
  // owner=mine does not open a second path around it.
  it('A5 (invariant guard): the maturity clamp still applies under owner=mine', async () => {
    claimsBox.claims = fakeClaims({
      sub: `user:${SUBJECT_ID}`,
      maxBrowsingLevel: sfwBrowsingLevelsFlag,
      domain: 'green',
    });
    const res = await invoke({ owner: 'mine', query: 'x', nsfw: 'true', browsingLevel: '31' });

    const [input, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(false);
    expect(input).not.toHaveProperty('browsingLevel');
    expect(mockResolveModelSearchIds.mock.calls[0][0].browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(res.body.maturity).toEqual({ browsingLevel: sfwBrowsingLevelsFlag, sfwOnly: true });
  });

  // A server that predates `owner` ignores it and serves the unscoped catalog with no marker, so
  // the echo is the only way a client can tell the two apart.
  it('echoes the applied owner filter as metadata.owner: mine, any, and any when absent', async () => {
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
    const cases: [Record<string, unknown>, string][] = [
      [{ owner: 'mine' }, 'mine'],
      [{ owner: 'mine', query: 'x' }, 'mine'],
      [{ owner: 'any' }, 'any'],
      [{}, 'any'],
      [{ query: 'x' }, 'any'],
    ];
    for (const [query, expected] of cases) {
      const res = await invoke(query);
      expect(res.statusCode, JSON.stringify(query)).toBe(200);
      expect(res.body.metadata.owner, JSON.stringify(query)).toBe(expected);
    }
  });

  it('asks for Public-availability versions only, with or without owner', async () => {
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
    await invoke({ query: 'x' });
    await invoke({ owner: 'mine', query: 'x' });
    expect(mockRunModelSearch).toHaveBeenCalledTimes(2);
    for (const [, ctx] of mockRunModelSearch.mock.calls) {
      expect(ctx.publicVersionsOnly).toBe(true);
    }
  });
});

describe('/api/v1/blocks/models — modelVersionIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    claimsBox.claims = fakeClaims({ sub: `user:${SUBJECT_ID}` });
  });

  it('forwards a comma-separated list as numbers', async () => {
    const res = await invoke({ modelVersionIds: '813,9021' });
    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch.mock.calls[0][0].modelVersionIds).toEqual([813, 9021]);
  });

  it('accepts the repeated-param form too', async () => {
    const res = await invoke({ modelVersionIds: ['813', '9021', '77'] });
    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch.mock.calls[0][0].modelVersionIds).toEqual([813, 9021, 77]);
  });

  it('accepts exactly 100 ids', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const res = await invoke({ modelVersionIds: ids.join(',') });
    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch.mock.calls[0][0].modelVersionIds).toEqual(ids);
  });

  it('rejects more than 100 ids, and anything that is not a positive int4, with 400', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    for (const bad of [tooMany, '0', '-4', '1.5', 'abc', '', '12,,13', '2147483648']) {
      const res = await invoke({ modelVersionIds: bad });
      expect(res.statusCode, `modelVersionIds=${bad.slice(0, 20)}`).toBe(400);
    }
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('rejects a comma list inside a repeated param with 400', async () => {
    const res = await invoke({ modelVersionIds: ['813', '9021,77'] });
    expect(res.statusCode).toBe(400);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  // Pins the shared helper's Number() coercion (commaDelimitedNumberArray), so a change to it is
  // seen here: these still have to land on a positive int4 to pass.
  it('reads ids through Number(): hex and exponent forms are coerced', async () => {
    const res = await invoke({ modelVersionIds: '0x1f,1e3' });
    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch.mock.calls[0][0].modelVersionIds).toEqual([31, 1000]);
  });

  it('accepts the int4 maximum', async () => {
    const res = await invoke({ modelVersionIds: '2147483647' });
    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch.mock.calls[0][0].modelVersionIds).toEqual([2147483647]);
  });

  it('composes with owner=mine (both constraints apply)', async () => {
    await invoke({ owner: 'mine', modelVersionIds: '813' });
    const [input, ctx] = mockRunModelSearch.mock.calls[0];
    expect(input.modelVersionIds).toEqual([813]);
    expect(ctx.ownerUserId).toBe(SUBJECT_ID);
  });

  it('absent → no version filter forwarded', async () => {
    await invoke({});
    expect(mockRunModelSearch.mock.calls[0][0].modelVersionIds).toBeUndefined();
  });
});
