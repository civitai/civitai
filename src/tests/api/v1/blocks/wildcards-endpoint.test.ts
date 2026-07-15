import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Endpoint-wiring tests for /api/v1/blocks/wildcards/[modelVersionId] —
 * mirrors models-endpoint.test.ts: withBlockScope is a passthrough stamping
 * per-test claims (JWT verify covered by middleware tests); the pack service
 * is mocked so no Prisma/redis/storage loads. Proves method/param gating, the
 * rate limit, the service-status → HTTP mapping, and that the service is
 * called with the CLAMPED browsing level (fail-closed SFW on a missing claim,
 * region-narrowed).
 */

const { mockGetPack, mockCheckRateLimit } = vi.hoisted(() => ({
  mockGetPack: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/services/blocks/wildcard-pack.service', () => ({
  getWildcardPackContent: mockGetPack,
  MAX_PACK_FILE_KB: 32 * 1024,
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
  getRegion: () => ({ countryCode: regionBox.restricted ? 'GB' : 'US' }),
  isRegionRestricted: () => regionBox.restricted,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
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
    headers: {} as Record<string, unknown>,
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

async function invoke(query: Record<string, unknown>, method = 'GET') {
  const mod = await import('~/pages/api/v1/blocks/wildcards/[modelVersionId]');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = {
    method,
    query,
    headers: {},
    url: '/api/v1/blocks/wildcards/111',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const okBody = {
  modelId: 42,
  modelVersionId: 111,
  modelName: 'Fantasy Pack',
  versionName: 'v1.0',
  creatorUsername: 'alice',
  lists: { race: ['elf'] },
  truncated: false,
  truncatedLists: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  regionBox.restricted = false;
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockGetPack.mockResolvedValue({ status: 'ok', body: okBody });
});

describe('/api/v1/blocks/wildcards/[modelVersionId] — gating', () => {
  it('405 on non-GET', async () => {
    expect((await invoke({ modelVersionId: '111' }, 'POST')).statusCode).toBe(405);
  });

  it('401 without claims (defense in depth)', async () => {
    claimsBox.claims = undefined;
    expect((await invoke({ modelVersionId: '111' })).statusCode).toBe(401);
  });

  it('400 on a non-numeric id, string error + details (block-friendly 400s)', async () => {
    const res = await invoke({ modelVersionId: 'abc' });
    expect(res.statusCode).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.details).toBeDefined();
  });

  it('429 with Retry-After when the per-token limiter trips — BEFORE the service', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });
    const res = await invoke({ modelVersionId: '111' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('7');
    expect(mockGetPack).not.toHaveBeenCalled();
  });
});

describe('service status → HTTP mapping', () => {
  it.each([
    ['not-found', 404],
    ['forbidden', 403],
    ['too-large', 422],
    ['fetch-failed', 502],
  ] as const)('%s -> %d', async (status, code) => {
    mockGetPack.mockResolvedValue({ status });
    expect((await invoke({ modelVersionId: '111' })).statusCode).toBe(code);
  });

  it('ok -> 200 with the body + the maturity echo', async () => {
    const res = await invoke({ modelVersionId: '111' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ...okBody, maturity: expect.any(Object) });
  });

  it('a thrown service error -> handleEndpointError (500), not an unhandled reject', async () => {
    mockGetPack.mockRejectedValue(new Error('boom'));
    expect((await invoke({ modelVersionId: '111' })).statusCode).toBe(500);
  });
});

describe('maturity clamp wiring', () => {
  it('missing maxBrowsingLevel claim -> fail-closed SFW level passed to the service', async () => {
    claimsBox.claims = fakeClaims(); // no maxBrowsingLevel
    await invoke({ modelVersionId: '111' });
    expect(mockGetPack).toHaveBeenCalledWith({
      modelVersionId: 111,
      browsingLevel: sfwBrowsingLevelsFlag,
    });
  });

  it('a red-domain ceiling passes through; a restricted region narrows it to SFW', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: 31 } as Partial<BlockTokenClaims>);
    await invoke({ modelVersionId: '111' });
    const wide = mockGetPack.mock.calls[0][0].browsingLevel;
    expect(wide).toBeGreaterThan(sfwBrowsingLevelsFlag & wide);

    regionBox.restricted = true;
    await invoke({ modelVersionId: '111' });
    const narrowed = mockGetPack.mock.calls[1][0].browsingLevel;
    expect(narrowed).toBe(narrowed & sfwBrowsingLevelsFlag);
  });
});
