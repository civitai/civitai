import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Endpoint-wiring tests for /api/v1/blocks/tools (#398 AC5).
 *
 * 🔴 THE POINT OF THIS FILE IS THE CLAMP. `withBlockScope` does NOT supply the
 * maturity clamp — it gives a route the JWT gate, CORS, the rate limit and the
 * audit row, and nothing else. A route added under `/api/v1/blocks/*` that never
 * calls `resolveCatalogBrowsingLevel` is UNCLAMPED while looking exactly as
 * protected as its neighbours, and no wrapper-level test would notice. So the
 * clamp assertions here carry a positive control: a RED token must produce a
 * DIFFERENT browsing level from a GREEN one, which is what distinguishes "the
 * clamp is applied" from "the search is wired to a constant".
 *
 * withBlockScope is mocked as a passthrough that stamps req.blockClaims (the
 * real token path is covered by the middleware's own tests); the search service
 * is mocked so no Prisma client loads. The opaque-origin CORS opt-in is pinned
 * separately in catalog-cors-wiring.test.ts, because a passthrough mock here
 * cannot see it.
 */

const { mockRunModelSearch, mockResolveModelSearchIds, mockCheckRateLimit } = vi.hoisted(() => ({
  mockRunModelSearch: vi.fn(),
  mockResolveModelSearchIds: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/services/model-search.service', () => ({
  runModelSearch: mockRunModelSearch,
  resolveModelSearchIds: mockResolveModelSearchIds,
  ModelSearchMeiliTimeoutError: class extends Error {},
}));

vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: mockCheckRateLimit,
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: any) => handler }));

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
    scopes: [],
    ...over,
  } as BlockTokenClaims;
}

function fakeRes() {
  const res: any = {
    headers: {},
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as NextApiResponse & { statusCode?: number; body?: any; headers: any };
}

async function invoke(method: 'GET' | 'POST' | 'DELETE', body?: unknown) {
  const mod = await import('~/pages/api/v1/blocks/tools');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method,
    query: {},
    body,
    headers: {},
    url: '/api/v1/blocks/tools',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

/** A raw search row carrying the fields the projection must strip. */
function rawRow(id = 4384) {
  return {
    id,
    name: 'DreamShaper',
    type: 'Checkpoint',
    creator: { username: 'Lykon' },
    stats: { downloadCount: 10 },
    tags: ['photorealistic'],
    modelVersions: [
      {
        id: 128713,
        baseModel: 'SD 1.5',
        air: `urn:air:sd1:checkpoint:civitai:${id}@128713`,
        files: [{ name: 'x.safetensors', hashes: { SHA256: 'abc' } }],
      },
    ],
  };
}

describe('/api/v1/blocks/tools — the allowlist and the argument contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('GET returns the tool declarations', async () => {
    const res = await invoke('GET');
    expect(res.statusCode).toBe(200);
    expect(res.body.tools.map((t: any) => t.function.name)).toEqual(['search_models']);
    expect(res.body.tools[0].function.parameters).toBeDefined();
  });

  it('🔴 POST with an UNKNOWN tool name is rejected, and never reaches the catalog', async () => {
    const res = await invoke('POST', { name: 'delete_everything', arguments: {} });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toContain('unknown tool');
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('🔴 POST with a PROTOTYPE key as the tool name is rejected', async () => {
    for (const name of ['toString', 'constructor']) {
      const res = await invoke('POST', { name, arguments: {} });
      expect(res.statusCode, `tool name '${name}'`).toBe(400);
    }
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('🔴 POST with arguments failing the tool schema is rejected before the catalog', async () => {
    const res = await invoke('POST', { name: 'search_models', arguments: { nope: 1 } });
    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).toContain('invalid arguments');
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — a VALID call does reach the catalog', async () => {
    // Without this, a handler that rejected everything would pass all three
    // cases above.
    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'dream' } });
    expect(res.statusCode).toBe(200);
    expect(mockRunModelSearch).toHaveBeenCalledTimes(1);
  });

  it('a non-GET/POST method is rejected', async () => {
    expect((await invoke('DELETE')).statusCode).toBe(405);
  });
});

describe('🔴 /api/v1/blocks/tools — the maturity clamp is applied IN THIS HANDLER', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('GREEN token → the CLAMPED SFW level reaches the search, passthrough false', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });

    expect(res.statusCode).toBe(200);
    const [args, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(false);
    expect(ctx.user).toBeUndefined();
    expect(args.disableMinor).toBe(true);
    // No mature bits leak.
    expect(ctx.browsingLevel & (4 | 8 | 16)).toBe(0);
    expect(res.body.maturity.sfwOnly).toBe(true);
  });

  it('🔴 POSITIVE CONTROL — a RED token yields a DIFFERENT level', async () => {
    // This is what separates "the clamp is applied" from "the search is wired to
    // a constant". Without it, a handler that hardcoded the SFW flag would pass
    // the green case above.
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: allBrowsingLevelsFlag });
    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });

    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(allBrowsingLevelsFlag);
    expect(ctx.browsingLevel).not.toBe(sfwBrowsingLevelsFlag);
    expect(res.body.maturity.sfwOnly).toBe(false);
  });

  it('🔴 a MISSING claim FAILS CLOSED to SFW', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: undefined });
    await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  it('🔴 a region-restricted viewer is clamped DOWN even on a RED token', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: allBrowsingLevelsFlag });
    regionBox.restricted = true;
    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    expect(res.body.maturity.sfwOnly).toBe(true);
  });

  it('the clamped level is also what the meili id resolution is given', async () => {
    // The clamp has to reach BOTH calls; a search that resolved ids at an
    // unclamped level would surface mature ids before the second filter.
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });
    expect(mockResolveModelSearchIds.mock.calls[0][0].browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });
});

describe('/api/v1/blocks/tools — the result is projected, scrubbed and bounded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [4384], nextCursor: undefined });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('🔴 the response carries no AIR literal — POSITIVE CONTROL on the source first', async () => {
    mockRunModelSearch.mockResolvedValue({ items: [rawRow()], nextCursor: undefined });
    // POSITIVE CONTROL: the upstream row really does carry one.
    expect(JSON.stringify(rawRow())).toContain('urn:air:');

    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'dream' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('urn:air:');
  });

  it('🔴 the response carries no files, hashes or download urls', async () => {
    mockRunModelSearch.mockResolvedValue({ items: [rawRow()], nextCursor: undefined });
    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'dream' } });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('safetensors');
    expect(json).not.toContain('SHA256');
    // POSITIVE CONTROL — the useful fields ARE present, so this is not passing
    // because the response is empty.
    expect(res.body.result.items[0]).toMatchObject({ id: 4384, name: 'DreamShaper' });
  });

  it('the response respects the caller limit', async () => {
    mockRunModelSearch.mockResolvedValue({
      items: [rawRow(1), rawRow(2), rawRow(3)],
      nextCursor: undefined,
    });
    await invoke('POST', { name: 'search_models', arguments: { query: 'd', limit: 2 } });
    expect(mockRunModelSearch.mock.calls[0][0].limit).toBe(2);
  });
});

describe('/api/v1/blocks/tools — rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
  });

  it('🔴 429s and never reaches the catalog when the per-token limit trips', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('7');
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('🔴 the limiter is keyed on the blockInstanceId', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('bki_test');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAPS AN AUDIT FOUND BY MUTATION. Each case below corresponds to a mutant that
// SURVIVED the original 42-test suite — i.e. the guard could be deleted and
// nothing went red. They are grouped rather than scattered so the reason they
// exist stays legible.
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 /api/v1/blocks/tools — guards that were unpinned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  // 🔴 NOT defence in depth. `withBlockScope` falls through to the wrapped
  // handler — rather than rejecting — both when no bearer token is present and
  // when `app-blocks-runtime-enabled` is off. Deleting the handler's own `!claims`
  // check therefore serves the declarations UNAUTHENTICATED. It previously
  // survived the whole suite.
  it('🔴 a request with NO claims is 401, on GET and on POST', async () => {
    claimsBox.claims = undefined;

    const get = await invoke('GET');
    expect(get.statusCode).toBe(401);
    expect(get.body).toEqual({ error: 'Block token required' });
    // The declarations must not leak through the unauthenticated path.
    expect(get.body.tools).toBeUndefined();

    const post = await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });
    expect(post.statusCode).toBe(401);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — the same GET succeeds once claims are present', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const res = await invoke('GET');
    expect(res.statusCode).toBe(200);
    expect(res.body.tools).toBeDefined();
  });

  // 🔴 THE SEAM. `boundToolResult` was unit-tested in isolation and the endpoint
  // never asserted its OUTPUT was bounded, so replacing the call with a
  // passthrough survived every test. Losing it produces a result the block
  // CANNOT replay — the chat step rejects an over-length `role:'tool'` message —
  // with no diagnostic. The fixture is deliberately maximal so the CHAR budget
  // binds before the item cap; asserting `< MAX_TOOL_RESULT_ITEMS` can only hold
  // if the budget actually ran.
  it('🔴 the char budget is applied AT THE SEAM, not merely unit-tested', async () => {
    const { MAX_TOOL_RESULT_ITEMS, MAX_TOOL_RESULT_CHARS } = await import(
      '~/server/services/blocks/tools/registry'
    );
    const fat = Array.from({ length: MAX_TOOL_RESULT_ITEMS }, (_, i) => ({
      ...rawRow(1000 + i),
      name: 'N'.repeat(300),
      creator: { username: 'U'.repeat(200) },
      tags: Array.from({ length: 8 }, () => 'T'.repeat(80)),
    }));
    mockRunModelSearch.mockResolvedValue({ items: fat, nextCursor: undefined });

    const res = await invoke('POST', {
      name: 'search_models',
      arguments: { query: 'x', limit: MAX_TOOL_RESULT_ITEMS },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.result.items.length).toBeLessThan(MAX_TOOL_RESULT_ITEMS);
    expect(res.body.result.truncated).toBeGreaterThan(0);
    expect(JSON.stringify(res.body.result.items).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  // The meili timeout arm: mutating its 503 to a 200 previously survived.
  it('🔴 a meili timeout is a 503 with Retry-After, not a 200', async () => {
    const { ModelSearchMeiliTimeoutError } = await import('~/server/services/model-search.service');
    mockResolveModelSearchIds.mockRejectedValue(new ModelSearchMeiliTimeoutError());

    const res = await invoke('POST', { name: 'search_models', arguments: { query: 'x' } });

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(mockRunModelSearch).not.toHaveBeenCalled();
    // 🔴 A LITERAL, never `e.message`. `rest-error-envelope-ledger` flags
    // `{ error: <ident>.message }` as a class regardless of whose text it is, and
    // a brand-new route must not land in that baseline.
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).toBe('Model search is temporarily overloaded — please retry.');
  });

  it('🔴 the wire body is STRICT — an unknown top-level key is rejected', async () => {
    const res = await invoke('POST', {
      name: 'search_models',
      arguments: { query: 'x' },
      extra: 'nope',
    });
    expect(res.statusCode).toBe(400);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  // nit 8: both 400 bodies reflect caller input, and the block hands our reply to
  // a chat model as a `role:'tool'` message — where `containsAirReference` throws
  // FORBIDDEN on the literal `urn:air:`. The wire pattern makes the `name`
  // reflection structurally inert; the scrub covers the free-text argument path.
  it('🔴 a tool NAME carrying an AIR literal is rejected, and the reply is replayable', async () => {
    const res = await invoke('POST', {
      name: 'urn:air:sd1:checkpoint:civitai:4384@128713',
      arguments: { query: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('urn:air:');
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });

  // 🔴 THE FIXTURE HAS TO REACH THE SCRUB, AND THE OBVIOUS ONE DOES NOT. A first
  // version sent `limit: 'urn:air:…'` — an invalid VALUE — and the mutant that
  // deletes the scrub SURVIVED, because zod reports "expected number, received
  // string" without echoing the value, so no AIR was ever in the message to
  // scrub. `.strict()`'s `unrecognized_keys` DOES echo the offending KEY
  // (measured: `Unrecognized key: "<key>"`), which is the path that reaches it.
  it('🔴 an ARGUMENT carrying an AIR literal yields a replayable 400 body', async () => {
    const res = await invoke('POST', {
      name: 'search_models',
      arguments: { query: 'x', 'urn:air:sd1:checkpoint:civitai:4384@128713': 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.stringify(res.body).toLowerCase();

    // POSITIVE CONTROL — the key WAS echoed, so the reflection path is live and
    // this assertion is not passing merely because nothing was reflected.
    expect(body).toContain('unrecognized key');
    expect(body).toContain('checkpoint:civitai:4384');

    // …and the AIR prefix within that echo is neutralised, so the block can
    // replay this body as a `role:'tool'` message without a FORBIDDEN.
    expect(body).not.toContain('urn:air:');
  });
});
