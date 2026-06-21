import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

import {
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

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

const { mockRunModelSearch, mockResolveModelSearchIds } = vi.hoisted(() => ({
  mockRunModelSearch: vi.fn(),
  mockResolveModelSearchIds: vi.fn(),
}));

// Holds the claims the mocked withBlockScope will stamp onto req for the
// current test. Set per-test before invoking the handler.
const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/services/model-search.service', () => ({
  runModelSearch: mockRunModelSearch,
  resolveModelSearchIds: mockResolveModelSearchIds,
  ModelSearchMeiliTimeoutError: class extends Error {},
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
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
    scopes: ['catalog:read'],
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
  const mod = await import('../models');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const req = { method: 'GET', query, headers: {}, url: '/api/v1/blocks/models' } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('/api/v1/blocks/models — authoritative clamp wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
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

  it('forwards the selector params (query/types/baseModels/sort/limit)', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    await invoke({
      query: 'dreamshaper',
      types: 'Checkpoint',
      baseModels: 'SDXL 1.0',
      sort: 'Most Downloaded',
      limit: '20',
    });

    const [input] = mockRunModelSearch.mock.calls[0];
    expect(input.query).toBe('dreamshaper');
    expect(input.types).toEqual(['Checkpoint']);
    expect(input.baseModels).toEqual(['SDXL 1.0']);
    expect(input.limit).toBe(20);
    // The Meili pre-step must be called with the CLAMPED level too.
    expect(mockResolveModelSearchIds).toHaveBeenCalledTimes(1);
    expect(mockResolveModelSearchIds.mock.calls[0][0].browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  it('rejects non-GET', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const mod = await import('../models');
    const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
    const req = { method: 'POST', query: {}, headers: {}, url: '/x' } as unknown as NextApiRequest;
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });
});
