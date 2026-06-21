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

const { mockRunImageSearch } = vi.hoisted(() => ({
  mockRunImageSearch: vi.fn(),
}));

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/services/image-search.service', () => ({
  runImageSearch: mockRunImageSearch,
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
    scopes: ['catalog:read'],
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
  const mod = await import('../images');
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
    mockRunImageSearch.mockResolvedValue({ items: [], nextCursor: undefined });
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

  it('rejects non-GET', async () => {
    claimsBox.claims = fakeClaims({ maxBrowsingLevel: sfwBrowsingLevelsFlag });
    const mod = await import('../images');
    const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
    const req = { method: 'POST', query: {}, headers: {}, url: '/x' } as unknown as NextApiRequest;
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });
});
