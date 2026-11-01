import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { HOSTED_MODEL_CAPABILITIES } from '~/shared/constants/hosted-model-catalog.constants';

import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';
import type * as RegionBlocking from '~/server/utils/region-blocking';

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

// The restricted-region list is read from env at module load, so the region case pins it here.
const mockIsRegionRestricted = vi.fn<(region: unknown) => boolean>(() => false);
vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<typeof RegionBlocking>()),
  isRegionRestricted: (region: unknown) => mockIsRegionRestricted(region),
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
/** What the service is handed with only `resourceIntentJev` on. */
const FLAGS_OFF_CTX = {
  browsingLevel: 31,
  poolMerge: false,
  v1: false,
  v1Shadow: false,
  judgeCapture: false,
};

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
  mockIsRegionRestricted.mockReturnValue(false);
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

  it('resourceIntentPoolMerge picks the POOL_MERGE arm; absent, the service gets false', async () => {
    await call({});
    expect(mockGetResourceIntent.mock.calls[0][1]).toMatchObject({ poolMerge: false });

    mockGetFeatureFlags.mockReturnValue({ resourceIntentJev: true, resourceIntentPoolMerge: true });
    await call({});
    expect(mockGetResourceIntent.mock.calls[1][1]).toMatchObject({ poolMerge: true });
  });

  it('🔴 the v1 flags reach the service each as its own field; absent, each is false', async () => {
    await call({});
    expect(mockGetResourceIntent.mock.calls[0][1]).toEqual(FLAGS_OFF_CTX);
    const flags = {
      resourceIntentV1: 'v1',
      resourceIntentV1Shadow: 'v1Shadow',
      resourceIntentJudgeCapture: 'judgeCapture',
    } as const;
    for (const [flag, field] of Object.entries(flags)) {
      mockGetResourceIntent.mockClear();
      mockGetFeatureFlags.mockReturnValue({ resourceIntentJev: true, [flag]: true });
      await call({});
      expect(mockGetResourceIntent.mock.calls[0][1], flag).toEqual({
        ...FLAGS_OFF_CTX,
        [field]: true,
      });
    }
  });

  it('the v1 flags alone do not open the route', async () => {
    mockGetFeatureFlags.mockReturnValue({
      resourceIntentV1: true,
      resourceIntentV1Shadow: true,
      resourceIntentJudgeCapture: true,
    });
    const { res } = await call({});
    expect(res.statusCode).toBe(404);
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });

  it('resourceIntentPoolMerge alone does not open the route', async () => {
    mockGetFeatureFlags.mockReturnValue({ resourceIntentPoolMerge: true });
    const { res } = await call({});
    expect(res.statusCode).toBe(404);
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
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

describe("kind: 'checkpoint' behind resourceIntentCheckpoint", () => {
  const CHECKPOINT_BODY = { ...VALID_BODY, kind: 'checkpoint' };

  it('🔴 flag off: a checkpoint request is a 400 before the rate limit; the service never runs', async () => {
    for (const flags of [
      { resourceIntentJev: true },
      { resourceIntentJev: true, resourceIntentCheckpoint: false },
    ]) {
      mockGetFeatureFlags.mockReturnValue(flags);
      const { res } = await call({ body: CHECKPOINT_BODY });
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "kind 'checkpoint' is not enabled" });
    }
    expect(mockCheckBlockLLMRateLimit).not.toHaveBeenCalled();
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });

  it('flag off: add-on requests (no kind, or kind addon) are served exactly as before', async () => {
    await call({});
    await call({ body: { ...VALID_BODY, kind: 'addon' } });
    expect(mockGetResourceIntent).toHaveBeenCalledTimes(2);
    expect(mockGetResourceIntent.mock.calls[0][0]).toEqual(VALID_BODY);
    expect(mockGetResourceIntent.mock.calls[0][1]).toEqual(FLAGS_OFF_CTX);
    expect(mockGetResourceIntent.mock.calls[1][0]).toEqual({ ...VALID_BODY, kind: 'addon' });
  });

  it('flag on: the request reaches the service with its kind; the route picks no arm (ATTACH_BM)', async () => {
    mockGetFeatureFlags.mockReturnValue({
      resourceIntentJev: true,
      resourceIntentCheckpoint: true,
    });
    const { res } = await call({ body: CHECKPOINT_BODY });
    expect(res.statusCode).toBe(200);
    expect(mockGetResourceIntent.mock.calls[0][0]).toEqual(CHECKPOINT_BODY);
    expect(mockGetResourceIntent.mock.calls[0][1]).toEqual(FLAGS_OFF_CTX);
  });

  it('🔴 checkpoint mode requires baseModel: 400 even with the flag on', async () => {
    mockGetFeatureFlags.mockReturnValue({
      resourceIntentJev: true,
      resourceIntentCheckpoint: true,
    });
    const { res } = await call({ body: { prompt: 'p', kind: 'checkpoint' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain("baseModel is required when kind is 'checkpoint'");
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
    // The add-on path still accepts a request without one.
    const ok = await call({ body: { prompt: 'p' } });
    expect(ok.res.statusCode).toBe(200);
  });

  it('🔴 checkpoint mode admits only a known base model (the add-on path does not check)', async () => {
    mockGetFeatureFlags.mockReturnValue({
      resourceIntentJev: true,
      resourceIntentCheckpoint: true,
    });
    for (const baseModel of ['NotABaseModel', 'sdxl 1.0', 'SDXL 1.0 ', 'x'.repeat(101)]) {
      const { res } = await call({ body: { prompt: 'p', kind: 'checkpoint', baseModel } });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        "baseModel must be a known base model when kind is 'checkpoint'"
      );
    }
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
    for (const baseModel of ['SDXL 1.0', 'Illustrious', 'Pony']) {
      expect(baseModels).toContain(baseModel);
      const { res } = await call({ body: { prompt: 'p', kind: 'checkpoint', baseModel } });
      expect(res.statusCode).toBe(200);
    }
    expect(mockGetResourceIntent).toHaveBeenCalledTimes(3);
    // The add-on path takes an unknown baseModel as before.
    expect((await call({ body: { prompt: 'p', baseModel: 'NotABaseModel' } })).res.statusCode).toBe(
      200
    );
    expect((await call({ body: { prompt: 'p', baseModel: 'x'.repeat(101) } })).res.statusCode).toBe(
      200
    );
  });

  it('an unknown kind is a 400', async () => {
    const { res } = await call({ body: { ...VALID_BODY, kind: 'lora' } });
    expect(res.statusCode).toBe(400);
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });

  it('resourceIntentCheckpoint alone does not open the route', async () => {
    mockGetFeatureFlags.mockReturnValue({ resourceIntentCheckpoint: true });
    const { res } = await call({ body: CHECKPOINT_BODY });
    expect(res.statusCode).toBe(404);
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });
});

describe('needs → hostedModels', () => {
  it('🔴 a request without needs gets exactly the body it got before: no hostedModels key', async () => {
    const { res } = await call({});
    expect(res.body).toEqual({
      ...SERVICE_RESULT,
      maturity: { browsingLevel: 31, sfwOnly: false },
    });
    expect(mockGetResourceIntent.mock.calls[0][0]).toEqual(VALID_BODY);
  });

  it('answers needs from the catalog on a SFW ceiling, and never passes needs to the primitive', async () => {
    const { res } = await call({
      __claims: { ...CLAIMS, maxBrowsingLevel: 3 },
      body: { ...VALID_BODY, needs: ['transparent_background'] },
    });
    expect(res.statusCode).toBe(200);
    expect(mockGetResourceIntent.mock.calls[0][0]).toEqual(VALID_BODY);
    expect(res.body).toMatchObject({
      ...SERVICE_RESULT,
      maturity: { browsingLevel: 3, sfwOnly: true },
      hostedModels: [
        {
          key: 'Ming',
          name: 'Ming Image Design',
          maker: 'inclusionAI',
          modelId: 2961930,
          url: 'https://civitai.com/models/2961930',
          capabilities: ['design_layout', 'legible_text', 'transparent_background'],
        },
      ],
    });
  });

  it('ranks and caps at three', async () => {
    const { res } = await call({
      __claims: { ...CLAIMS, maxBrowsingLevel: 3 },
      body: { ...VALID_BODY, needs: ['legible_text', 'design_layout'] },
    });
    const hosted = (res.body as { hostedModels: { key: string }[] }).hostedModels;
    expect(hosted.map((h) => h.key)).toEqual(['Reve', 'Ideogram', 'Ming']);
  });

  it('🔴 the browsing ceiling does not change hostedModels: same list for SFW, mature and region-clamped', async () => {
    const body = { ...VALID_BODY, needs: ['legible_text', 'design_layout'] };
    const sfw = await call({ __claims: { ...CLAIMS, maxBrowsingLevel: 3 }, body });
    const mature = await call({ body });
    mockIsRegionRestricted.mockReturnValue(true);
    const clamped = await call({ body });
    const read = (r: { res: { body: unknown } }) =>
      r.res.body as { maturity: { sfwOnly: boolean }; hostedModels: { key: string }[] };
    // The ceilings really differ, so an equal list is not an accident of identical inputs.
    expect([sfw, mature, clamped].map((r) => read(r).maturity.sfwOnly)).toEqual([
      true,
      false,
      true,
    ]);
    expect(read(mature).hostedModels).toEqual(read(sfw).hostedModels);
    expect(read(clamped).hostedModels).toEqual(read(sfw).hostedModels);
    // Ideogram and Nano Banana included on a mature ceiling too.
    expect(read(mature).hostedModels.map((h) => h.key)).toEqual(['Reve', 'Ideogram', 'Ming']);
    const nano = await call({ body: { ...VALID_BODY, needs: ['character_consistency'] } });
    expect(read(nano).hostedModels.map((h) => h.key)).toEqual(['NanoBanana', 'HiDream-O1']);
  });

  it('empty needs is answered with an empty list, not omitted', async () => {
    const { res } = await call({
      __claims: { ...CLAIMS, maxBrowsingLevel: 3 },
      body: { ...VALID_BODY, needs: [] },
    });
    expect((res.body as Record<string, unknown>).hostedModels).toEqual([]);
  });

  it('an unknown capability is a 400 before the rate limit', async () => {
    for (const needs of [['legible_text', 'nsfw'], 'legible_text', [1]]) {
      const { res } = await call({ body: { ...VALID_BODY, needs } });
      expect(res.statusCode).toBe(400);
    }
    expect(mockCheckBlockLLMRateLimit).not.toHaveBeenCalled();
    expect(mockGetResourceIntent).not.toHaveBeenCalled();
  });

  it('accepts every capability once (8) and refuses a ninth', async () => {
    const all = [...HOSTED_MODEL_CAPABILITIES];
    expect(all).toHaveLength(8);
    expect((await call({ body: { ...VALID_BODY, needs: all } })).res.statusCode).toBe(200);
    const nine = await call({ body: { ...VALID_BODY, needs: [...all, 'photoreal'] } });
    expect(nine.res.statusCode).toBe(400);
  });

  it('needs is stripped on the checkpoint path too', async () => {
    mockGetFeatureFlags.mockReturnValue({
      resourceIntentJev: true,
      resourceIntentCheckpoint: true,
    });
    const body = { ...VALID_BODY, kind: 'checkpoint', needs: ['photoreal'] };
    const { res } = await call({ __claims: { ...CLAIMS, maxBrowsingLevel: 3 }, body });
    expect(mockGetResourceIntent.mock.calls[0][0]).toEqual({ ...VALID_BODY, kind: 'checkpoint' });
    const hosted = (res.body as { hostedModels: { key: string }[] }).hostedModels;
    expect(hosted.map((h) => h.key)).toEqual(['MAI']);
  });

  it('a degraded primitive response still carries the hosted list', async () => {
    mockGetResourceIntent.mockResolvedValue({ ...SERVICE_RESULT, degraded: true });
    const { res } = await call({
      __claims: { ...CLAIMS, maxBrowsingLevel: 3 },
      body: { ...VALID_BODY, needs: ['transparent_background'] },
    });
    expect(res.body).toMatchObject({ degraded: true, hostedModels: [{ key: 'Ming' }] });
  });
});
