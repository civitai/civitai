import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';

/**
 * Endpoint-contract tests for POST /api/v1/blocks/resource-intent.
 *
 * Lives here, not beside the route: Next treats every file under src/pages as a
 * route and `next build` runs a route-type validator over it (see
 * announcements-endpoint.test.ts for the precedent).
 *
 * What is pinned here is the AUTH/CLAMP MIRROR with generation-resources.ts:
 * the token requirement, the deny-before-spend flag gate, the per-instance LLM
 * rate-limit refusal shape, and the authoritative maturity clamp reaching the
 * service. The primitive's internals are mocked — they have their own suites.
 */

const mockGetFeatureFlags = vi.fn();
const mockCheckBlockLLMRateLimit = vi.fn();
const mockGetResourceIntent = vi.fn();

vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof BlockScopeMiddleware>();
  return {
    ...actual,
    // Inject the verified claims the real middleware would produce, then hand
    // the handler through so the test drives THIS endpoint's own gates.
    withBlockScope:
      (handler: (req: unknown, res: unknown) => Promise<void>) =>
      async (req: Record<string, unknown>, res: unknown) => {
        req.blockClaims = req.__claims;
        return handler(req, res);
      },
  };
});

// Hand-listed mocks, deliberately — the endpoint-contract seam. importOriginal
// of feature-flags.service would evaluate the whole flag registry + the lazy
// Flipt module load; of block-catalog-rate-limit, the real redis client; of
// resource-intent.service, the vendor client and the matcher graph. The suite
// isolates the handler's OWN gates (the middleware's are covered by its own
// suites + the no-unguarded-block-rest-token ledger, which pins THIS route as
// wrapped). A new import from any of these modules in the endpoint breaks this
// file at load — the documented cost of the trade.
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: (...args: unknown[]) => mockGetFeatureFlags(...(args as [])),
}));

vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockLLMRateLimit: (...args: unknown[]) => mockCheckBlockLLMRateLimit(...(args as [])),
}));

vi.mock('~/server/services/resource-intent.service', () => ({
  getResourceIntent: (...args: unknown[]) => mockGetResourceIntent(...(args as [])),
}));

const handler = (await import('~/pages/api/v1/blocks/resource-intent')).default;

const CLAIMS = {
  sub: 'user:1',
  blockId: 'blk',
  appId: 'app',
  appBlockId: 'apb',
  blockInstanceId: 'inst_1',
  scopes: [],
  iat: 0,
  exp: 0,
  jti: 'jti',
  maxBrowsingLevel: 31,
};

const VALID_BODY = { prompt: 'a photorealistic portrait of a knight', baseModel: 'SDXL 1.0' };

const SERVICE_RESULT = {
  degraded: false,
  insightFallback: false,
  intent: null,
  criteria: null,
  suggestions: [],
  noneProbability: null,
  model: 'typesafe/jev-1.13-20260917',
  criteriaVersion: 2,
};

function makeRes() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return res;
    },
  };
  return { res, headers };
}

const call = async (req: Record<string, unknown>) => {
  const { res, headers } = makeRes();
  await (handler as unknown as (r: unknown, s: unknown) => Promise<void>)(
    { method: 'POST', body: VALID_BODY, __claims: CLAIMS, headers: {}, ...req },
    res
  );
  return { res, headers };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetFeatureFlags.mockReturnValue({ resourceIntentJev: true });
  mockCheckBlockLLMRateLimit.mockResolvedValue({ allowed: true });
  mockGetResourceIntent.mockResolvedValue(SERVICE_RESULT);
});

describe('the auth/clamp mirror with generation-resources.ts', () => {
  it('rejects non-POST methods', async () => {
    const { res } = await call({ method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });

  it('rejects a request without verified block claims', async () => {
    const { res } = await call({ __claims: undefined });
    expect(res.statusCode).toBe(401);
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });

  it('is deny-by-default when the flag is absent — before the rate limit or any spend', async () => {
    mockGetFeatureFlags.mockReturnValue({});
    const { res } = await call({});
    expect(res.statusCode).toBe(404);
    expect(mockCheckBlockLLMRateLimit).not.toHaveBeenCalled();
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
    expect(mockGetFeatureFlags.mock.calls[0][0]).toMatchObject({ req: expect.anything() });
  });

  it('rejects an invalid body before the rate limit', async () => {
    const { res } = await call({ body: { prompt: '' } });
    expect(res.statusCode).toBe(400);
    expect(mockCheckBlockLLMRateLimit).not.toHaveBeenCalled();
  });

  it('refuses a rate-limited instance with Retry-After', async () => {
    mockCheckBlockLLMRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { res, headers } = await call({});
    expect(res.statusCode).toBe(429);
    expect(headers.get('Retry-After')).toBe('42');
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });

  it('rate-limits on the LLM bucket keyed by the stable instance id', async () => {
    await call({});
    expect(mockCheckBlockLLMRateLimit).toHaveBeenCalledWith('inst_1');
  });

  it('clamps the browsing level from the token and hands it to the service', async () => {
    await call({ __claims: { ...CLAIMS, maxBrowsingLevel: 3 } });
    expect(mockGetResourceIntent).toHaveBeenCalledTimes(1);
    const [input, ctx] = mockGetResourceIntent.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { browsingLevel: number; coverage: unknown }
    ];
    expect(input).toEqual(VALID_BODY);
    // 3 = PG|PG13: the SFW intersection of any ceiling below 4.
    expect(ctx.browsingLevel).toBe(3);
  });

  it('serves the primitive result with the applied ceiling echoed', async () => {
    const { res } = await call({});
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ...SERVICE_RESULT,
      maturity: { browsingLevel: 31, sfwOnly: false },
    });
  });

  it('a degraded response is still a 200 with empty suggestions', async () => {
    mockGetResourceIntent.mockResolvedValue({
      ...SERVICE_RESULT,
      degraded: true,
      model: 'jev-unavailable',
    });
    const { res } = await call({});
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ degraded: true, suggestions: [] });
  });
});
