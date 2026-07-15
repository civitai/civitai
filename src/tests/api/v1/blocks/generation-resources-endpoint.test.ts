import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Custom Generators (Phase-2a PR-C) — endpoint-wiring tests for
 * GET /api/v1/blocks/generation-resources (rehydrate a saved generator's
 * resources). Proves: the projected safe subset, the maturity clamp (mature
 * resources dropped on a SFW ceiling), the ≤30 ids bound, and the no-claims 401.
 *
 * withBlockScope is mocked as a passthrough that stamps req.blockClaims; getResourceData
 * is mocked so no Prisma client loads.
 */

const { mockGetResourceData, mockCheckRateLimit } = vi.hoisted(() => ({
  mockGetResourceData: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: mockGetResourceData,
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
  getRegion: () => ({ countryCode: 'US', regionCode: null, fullLocationCode: 'US' }),
  isRegionRestricted: () => regionBox.restricted,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
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

async function invoke(query: Record<string, unknown>, method = 'GET') {
  const mod = await import('~/pages/api/v1/blocks/generation-resources');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = { method, query, headers: {}, url: '/api/v1/blocks/generation-resources' } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

// A SFW resource + a mature one, in the getResourceData row shape.
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 100,
    name: 'v1',
    baseModel: 'SDXL 1.0',
    strength: 0.7,
    minStrength: -1,
    maxStrength: 2,
    trainedWords: ['w'],
    clipSkip: 2,
    model: { id: 1, name: 'M', type: 'LORA', nsfw: false },
    image: { id: 9, url: 'u', nsfwLevel: NsfwLevel.PG },
    hasAccess: true,
    availability: 'Public',
    ...over,
  };
}

describe('/api/v1/blocks/generation-resources — projection + clamp + bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    regionBox.restricted = false;
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('returns the safe projected subset (no internals) for a SFW token', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockGetResourceData.mockResolvedValue([row()]);
    const res = await invoke({ ids: '100' });

    expect(res.statusCode).toBe(200);
    expect(mockGetResourceData).toHaveBeenCalledWith([100]);
    expect(res.body.items).toEqual([
      {
        versionId: 100,
        modelId: 1,
        modelName: 'M',
        versionName: 'v1',
        baseModel: 'SDXL 1.0',
        modelType: 'LORA',
        strength: 0.7,
        minStrength: -1,
        maxStrength: 2,
        trainedWords: ['w'],
        clipSkip: 2,
      },
    ]);
    // No internals in the response.
    const s = JSON.stringify(res.body.items);
    expect(s).not.toContain('hasAccess');
    expect(s).not.toContain('availability');
    expect(res.body.maturity).toEqual({ browsingLevel: sfwBrowsingLevelsFlag, sfwOnly: true });
  });

  it('DROPS a mature resource for a SFW token (maturity clamp)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockGetResourceData.mockResolvedValue([
      row({ id: 100 }),
      row({ id: 200, image: { id: 2, url: 'x', nsfwLevel: NsfwLevel.R } }),
      row({ id: 300, image: undefined, model: { id: 3, name: 'N', type: 'LORA', nsfw: true } }),
    ]);
    const res = await invoke({ ids: '100,200,300' });

    expect(res.statusCode).toBe(200);
    // Only the SFW resource survives; the R-cover + nsfw-model rows are dropped.
    expect(res.body.items.map((i: any) => i.versionId)).toEqual([100]);
  });

  it('RED token gets mature resources back (no clamp)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: allBrowsingLevelsFlag });
    mockGetResourceData.mockResolvedValue([
      row({ id: 100 }),
      row({ id: 200, image: { id: 2, url: 'x', nsfwLevel: NsfwLevel.R } }),
    ]);
    const res = await invoke({ ids: '100,200' });

    expect(res.body.items.map((i: any) => i.versionId)).toEqual([100, 200]);
    expect(res.body.maturity.sfwOnly).toBe(false);
  });

  it('accepts an ids ARRAY, de-dupes + parses, and bounds at 30', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockGetResourceData.mockResolvedValue([]);
    await invoke({ ids: ['1', '2', '2', '3'] });
    expect(mockGetResourceData).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('400s when more than 30 ids are requested', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const ids = Array.from({ length: 31 }, (_, i) => i + 1).join(',');
    const res = await invoke({ ids });
    expect(res.statusCode).toBe(400);
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('400s when ids is missing / all-junk', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    expect((await invoke({})).statusCode).toBe(400);
    expect((await invoke({ ids: 'abc,-5,0' })).statusCode).toBe(400);
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('401s when no block claims were stamped (bad / missing token)', async () => {
    claimsBox.claims = undefined;
    const res = await invoke({ ids: '1' });
    expect(res.statusCode).toBe(401);
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('rejects non-GET', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const res = await invoke({ ids: '1' }, 'POST');
    expect(res.statusCode).toBe(405);
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('over the per-token ceiling → 429 + Retry-After, getResourceData NOT called', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 6 });
    const res = await invoke({ ids: '1' });
    expect(res.statusCode).toBe(429);
    expect((res as unknown as { headers: Record<string, unknown> }).headers['Retry-After']).toBe(
      '6'
    );
    expect(mockCheckRateLimit).toHaveBeenCalledWith('bki_test');
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });
});
