import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as JevModule from '~/server/services/ai/jev';

/**
 * Service-flow tests for the resource-intent primitive. Pinned literal
 * expectations throughout — none of these are derived from the implementation
 * under test. The Jev seam, the matcher, redis, getResourceData, ClickHouse and
 * the axiom logger are all mocked at their module seams; the criteria
 * compilation, the stage-3 reorder, the hydration gates and the cache contract
 * run for real.
 */

const mockAskJev = vi.fn();
const mockFindCandidates = vi.fn();
const mockGetResourceData = vi.fn();
const mockInsert = vi.fn();

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
}));

import type * as MatcherModule from '~/server/services/resource-intent-matcher.service';

vi.mock('~/server/services/resource-intent-matcher.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MatcherModule>()),
  findResourceIntentCandidates: (...args: unknown[]) => mockFindCandidates(...(args as [])),
}));

// Hand-listed, deliberately: generation.service is an 8k-line hub whose
// importOriginal spread would drag its whole transitive graph (featured-model
// caches, orchestrator client, Prisma edges) into a suite that needs ONE
// function — the same trade resource-select.pricing-filter.test.ts records for
// model.service. A new import from it in resource-intent.service.ts breaks this
// suite at load, which is the documented cost.
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));

// Live-binding holder so a test can observe the clickhouse-unwired fallback.
const clickhouseHolder: { client: unknown } = { client: undefined };
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return clickhouseHolder.client;
  },
}));

vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const { getResourceIntent, resourceIntentCacheKey } = await import(
  '~/server/services/resource-intent.service'
);

const INPUT = { prompt: 'a photorealistic portrait of a knight' } as const;
const CTX = { browsingLevel: 3, coverage: { next: false, member: false } };

const STAGE1_ANSWERS = [
  { id: 'needsResource', type: 'noul' as const, value: 0.9 },
  {
    id: 'role',
    type: 'choice' as const,
    value: 'style',
    distribution: { style: 0.7, character: 0.2, none: 0.1 },
  },
  {
    id: 'styleFamily',
    type: 'choice' as const,
    value: 'anime_manga',
    distribution: { anime_manga: 0.8, photorealistic: 0.2 },
  },
  {
    id: 'contentType',
    type: 'choice' as const,
    value: 'portrait_character',
    distribution: { portrait_character: 1 },
  },
  { id: 'specificity', type: 'score' as const, value: 3 },
  { id: 'injectionPresent', type: 'noul' as const, value: 0 },
];

const SHORTLIST = [
  {
    versionId: 11,
    modelId: 1,
    modelName: 'LoRA One',
    versionName: 'v1',
    baseModel: 'SDXL 1.0',
    modelType: 'LORA',
    thumbsUpCount: 30,
  },
  {
    versionId: 22,
    modelId: 2,
    modelName: 'LoRA Two',
    versionName: 'v1',
    baseModel: 'SDXL 1.0',
    modelType: 'LORA',
    thumbsUpCount: 20,
  },
];

const genResource = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `version-${id}`,
  baseModel: 'SDXL 1.0',
  strength: 0.8,
  minStrength: -1,
  maxStrength: 2,
  trainedWords: ['trigger1'],
  clipSkip: 2,
  hasAccess: true,
  canGenerate: true,
  model: { id: 100 + id, name: `model-${id}`, type: 'LORA', nsfw: false, poi: false, userId: 1 },
  image: { url: 'https://example.com/x.jpeg', type: 'image/jpeg', nsfwLevel: 1 },
  air: `air:${id}`,
  ...overrides,
});

function mockStage1() {
  mockAskJev.mockImplementationOnce(async () => ({
    answers: STAGE1_ANSWERS,
    usage: { promptTokens: 100, completionTokens: 50 },
    // A DATED build, not the bare pin: `askJev` now returns the model the vendor
    // reports answered, and a response carrying the bare pin is possible but is not
    // what the live endpoint sends. A fixture production can never produce is not a
    // fixture. `jev.test.ts` covers both arms of the pin check.
    model: 'typesafe/jev-1.13-20260917',
  }));
}

function mockStage3(distribution: Record<string, number>, value = '0') {
  mockAskJev.mockImplementationOnce(async () => ({
    answers: [{ id: 'resourceVersion', type: 'choice' as const, value, distribution }],
    usage: { promptTokens: 200, completionTokens: 20 },
    model: 'typesafe/jev-1.13-20260917',
  }));
}

beforeEach(() => {
  clickhouseHolder.client = { insert: mockInsert };
  mockAskJev.mockReset();
  mockFindCandidates.mockReset();
  mockFindCandidates.mockResolvedValue([]);
  mockGetResourceData.mockReset();
  mockGetResourceData.mockResolvedValue([]);
  mockInsert.mockReset();
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
});

describe('cache behavior', () => {
  it('key is stable per (prompt, baseModel, browsingLevel, cap, spec version) and differs otherwise', () => {
    const base = { prompt: 'p', baseModel: 'SDXL 1.0', browsingLevel: 3, cap: 50 };
    const a = resourceIntentCacheKey(base);
    const b = resourceIntentCacheKey({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^packed:caches:jev-resource-intent:v1:[0-9a-f]{64}$/);
    expect(resourceIntentCacheKey({ ...base, baseModel: 'Pony' })).not.toBe(a);
    expect(resourceIntentCacheKey({ ...base, browsingLevel: 31 })).not.toBe(a);
    expect(resourceIntentCacheKey({ ...base, prompt: 'different' })).not.toBe(a);
    // 🔴 `cap` bounds the shortlist, so it bounds the cached suggestions. Sharing
    // one entry across caps made a limit=1 request inherit a limit=50 entry's 50
    // suggestions for the full hour TTL (and the reverse under-serve). Red before
    // the fix: `cap` was absent from the key and this call was identical to `a`.
    expect(resourceIntentCacheKey({ ...base, cap: 1 })).not.toBe(a);
  });

  it('🔴 never serves more suggestions than the caller asked for, even from a wider entry', async () => {
    // An entry written under an OLDER key shape (i.e. at a wider cap) landing on
    // this request's key is the case the key change alone cannot fix — the
    // serve-time truncation is what holds the contract. Planted directly.
    const wide = {
      degraded: false,
      intent: {
        needsResource: 0.9,
        role: { value: 'style' as const, distribution: { style: 1 } },
        styleFamily: { value: 'anime_manga' as const, distribution: { anime_manga: 1 } },
        contentType: {
          value: 'portrait_character' as const,
          distribution: { portrait_character: 1 },
        },
        specificity: 3,
        injectionPresent: 0,
      },
      criteria: {
        criteriaVersion: 1 as const,
        specHash: 'abc',
        role: 'style' as const,
        modelTypes: ['LORA' as const],
        baseModel: null,
      },
      suggestions: [{ versionId: 11 }, { versionId: 22 }, { versionId: 33 }],
      noneProbability: 0.1,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 1 as const,
    };
    redisMock.redis.packed.get.mockResolvedValue(wide);

    const result = await getResourceIntent({ ...INPUT, limit: 2 }, CTX);

    // Pinned literal: the caller asked for 2, so it gets exactly the first 2 in
    // the cached order — never the third.
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([11, 22]);
    // No Jev call: this was a cache hit that was narrowed, not a recompute.
    expect(mockAskJev).not.toHaveBeenCalled();
  });

  it('passes the resolved cap to the matcher and honours limit end-to-end', async () => {
    mockStage1();
    mockStage3({ '0': 0.6, '1': 0.4, none: 0 });
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockGetResourceData.mockResolvedValue([genResource(11), genResource(22)]);

    const result = await getResourceIntent({ ...INPUT, limit: 1 }, CTX);

    expect(mockFindCandidates.mock.calls[0][1]).toMatchObject({ cap: 1 });
    expect(result.suggestions).toHaveLength(1);
  });

  it('a cache hit short-circuits both Jev calls and is NOT rewritten', async () => {
    const cached = {
      degraded: false,
      intent: {
        needsResource: 0.9,
        role: { value: 'style', distribution: { style: 1 } },
        styleFamily: { value: 'anime_manga', distribution: { anime_manga: 1 } },
        contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
        specificity: 3,
        injectionPresent: 0,
      },
      criteria: {
        criteriaVersion: 1,
        specHash: 'abc',
        role: 'style',
        modelTypes: ['LORA'],
        baseModel: null,
      },
      suggestions: [],
      noneProbability: 0.1,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 1,
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);

    const result = await getResourceIntent(INPUT, CTX);

    expect(mockAskJev).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    expect(result).toEqual(cached);
  });

  it('a corrupted cached blob is ignored and recomputed', async () => {
    redisMock.redis.packed.get.mockResolvedValue({ not: 'a response' });
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(mockAskJev).toHaveBeenCalledTimes(1);
  });

  it('a cache read failure is a miss, never an error', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('redis down'));
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
  });

  it('a successful response caches for 1h; a degraded one for 60s', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    await getResourceIntent(INPUT, CTX);
    expect(redisMock.redis.packed.set).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 3600 });

    redisMock.redis.packed.set.mockClear();
    mockAskJev.mockReset();
    mockAskJev.mockRejectedValue(new Error('timeout'));
    await getResourceIntent(INPUT, CTX);
    expect(redisMock.redis.packed.set).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
  });
});

describe('degradation — fail closed, fail empty', () => {
  it('a Jev timeout yields a 200-shaped degraded response with empty suggestions', async () => {
    mockAskJev.mockRejectedValue(new Error('Jev call exceeded 2000ms'));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(result.intent).toBeNull();
    expect(result.criteria).toBeNull();
    expect(result.model).toBe('jev-unavailable');
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('a matcher failure degrades the same way', async () => {
    mockStage1();
    mockFindCandidates.mockRejectedValue(new Error('meili down'));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(true);
    expect(result.suggestions).toEqual([]);
  });

  it('a hydration failure degrades instead of leaking a partial list', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockStage3({ '0': 0.7, '1': 0.2, none: 0.1 });
    mockGetResourceData.mockRejectedValue(new Error('db down'));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(true);
    expect(result.suggestions).toEqual([]);
  });
});

describe('stage flow', () => {
  it('role=none short-circuits to empty suggestions WITHOUT being degraded', async () => {
    mockAskJev.mockImplementationOnce(async () => ({
      answers: STAGE1_ANSWERS.map((a) =>
        a.id === 'role' ? { ...a, value: 'none', distribution: { style: 0.2, none: 0.8 } } : a
      ),
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'typesafe/jev-1.13-20260917',
    }));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect(result.intent?.role.value).toBe('none');
    expect(result.noneProbability).toBe(0.8);
    expect(mockFindCandidates).not.toHaveBeenCalled();
    expect(mockAskJev).toHaveBeenCalledTimes(1);
  });

  it('compiles criteria from the role mapping and caller-supplied baseModel', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    const result = await getResourceIntent({ ...INPUT, baseModel: 'SDXL 1.0' }, CTX);
    expect(result.criteria).toEqual({
      criteriaVersion: 1,
      specHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      role: 'style',
      modelTypes: [
        'LORA',
        'TextualInversion',
        'LoCon',
        'DoRA',
        'AestheticGradient',
        'Hypernetwork',
      ],
      baseModel: 'SDXL 1.0',
    });
    // The matcher received the same compiled criteria.
    expect(mockFindCandidates.mock.calls[0][0]).toEqual(result.criteria);
    // The browsing level and cap reached the matcher.
    expect(mockFindCandidates.mock.calls[0][1]).toMatchObject({ browsingLevel: 3, cap: 50 });
  });

  it('stage 3 reorders the shortlist by the distribution (gate-passing entries only)', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockStage3({ '1': 0.6, '0': 0.3, none: 0.1 }, '1');
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([22, 11]);
    expect(result.suggestions[0]).toEqual({
      versionId: 22,
      modelId: 122,
      modelName: 'model-22',
      versionName: 'version-22',
      baseModel: 'SDXL 1.0',
      modelType: 'LORA',
      strength: 0.8,
      minStrength: -1,
      maxStrength: 2,
      trainedWords: ['trigger1'],
      clipSkip: 2,
    });
    // Hydration is called with the DISTRIBUTION order, not the popularity order.
    expect(mockGetResourceData.mock.calls[0][0]).toEqual([22, 11]);
  });

  it('a stage-3 "none" argmax returns empty suggestions without being degraded', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockStage3({ '0': 0.3, '1': 0.2, none: 0.5 }, 'none');
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect(result.noneProbability).toBe(0.5);
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('an empty shortlist skips stage 3 entirely (no forced fits)', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect(mockAskJev).toHaveBeenCalledTimes(1);
  });

  it('stage 3 never offers more than the vendor option budget minus the none fallback', async () => {
    const { STAGE3_MAX_RANKED } = await import('~/server/schema/resource-intent.schema');
    const { buildStage3Question } = await import('~/server/services/resource-intent.service');
    const bigShortlist = Array.from({ length: STAGE3_MAX_RANKED + 50 }, (_, i) => ({
      versionId: i + 1,
      modelId: 1,
      modelName: `m${i}`,
      versionName: 'v',
      baseModel: 'SDXL 1.0',
      modelType: 'LORA',
      thumbsUpCount: 1,
    }));
    const question = buildStage3Question(bigShortlist);
    // 254 ranked entries + 'none' = exactly the vendor's 255-option budget.
    expect(question.options).toHaveLength(255);
    expect(question.options.at(-1)).toBe('none');
    expect(question.options[0]).toBe('0');
  });

  it('hydration re-applies the gates: a non-public version is dropped, not shipped', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockStage3({ '0': 0.7, '1': 0.2, none: 0.1 });
    mockGetResourceData.mockImplementation(async () => [
      // 11 is public and fine; 22 comes back without access (e.g. index lag) — it must vanish.
      genResource(11),
      genResource(22, { hasAccess: false }),
    ]);
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([11]);
  });

  // ⚠️ REMOVED: 'hydration drops a mature version on a SFW ceiling', which planted a
  // cover `nsfwLevel: 4`. That input is now unreachable in production on BOTH callers
  // of resourceExceedsCatalogCeiling: `resource.image` has exactly one writer and it
  // sits inside getResourceData's `if (withPreview)`, which neither caller sets. The
  // `imageNsfwLevel` arm is therefore dead, and a test exercising it asserted nothing
  // about a path that can run. The reachable case is the one below.
  it('🔴 drops a mature-FLAGGED model whose cover image is SFW', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockStage3({ '0': 0.7, '1': 0.2, none: 0.1 });
    // The reachable case the sibling test above CANNOT produce. `pickPreviewImage`
    // only ever returns an image already visible at the ceiling, so an image level
    // of 4 against a SFW ceiling is not something production can hand us — while
    // `Model.nsfw = true` with a PG cover is both common and, under the old
    // `withPreview: true`, silently admitted: a present image level shadows
    // `modelNsfw` in resourceExceedsCatalogCeiling.
    mockGetResourceData.mockImplementation(async () => [
      genResource(11),
      // No `image` — that is what production now returns, since the service no
      // longer asks for a preview. `modelNsfw` is therefore the active signal.
      (({ image: _image, ...rest }) => ({
        ...rest,
        model: { ...rest.model, nsfw: true },
      }))(genResource(22)),
    ]);
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([11]);
  });

  it('🔴 does NOT ask getResourceData for a preview image', async () => {
    // The behavioural arm above passes whether or not `withPreview` is sent,
    // because the mock ignores it — so THIS is the arm that pins the fix.
    // Requesting a preview re-populates `image.nsfwLevel`, which shadows
    // `modelNsfw` and reopens the hole. It also buys nothing: the projection
    // emits no image field.
    mockStage1();
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockStage3({ '0': 0.7, '1': 0.2, none: 0.1 });
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );
    await getResourceIntent(INPUT, CTX);
    // Asserted on the WHOLE options argument, not one key: `withPreview: false`
    // would satisfy a `not.toHaveProperty` check while re-adding the option, and
    // `browsingLevel` is inert here (getResourceData reads it only inside its
    // `if (withPreview)` branch), so passing either is the thing to catch.
    expect(mockGetResourceData.mock.calls[0][1]).toBeUndefined();
  });
});

describe('shadow event', () => {
  it('🔴 a degrade REPLAYED from cache is tagged, not left with a blank reason', async () => {
    // A cached degrade never enters the catch, so it has no reason of its own and
    // emits no `resource-intent-degraded` log. Untagged it lands as `degraded=1`
    // with an EMPTY reason — and the migration's fallback-rate query groups BY
    // reason, so those rows pool in a blank bucket that reads like a writer bug.
    redisMock.redis.packed.get.mockResolvedValue({
      degraded: true,
      intent: null,
      criteria: null,
      suggestions: [],
      noneProbability: null,
      model: 'jev-unavailable',
      criteriaVersion: 1,
    });

    await getResourceIntent(INPUT, { ...CTX, now: () => new Date('2026-09-29T00:00:00.000Z') });

    expect(mockAskJev).not.toHaveBeenCalled(); // confirm it really was a cache hit
    const row = mockInsert.mock.calls[0][0].values[0] as Record<string, unknown>;
    expect(row.degraded).toBe(1);
    expect(row.degradedReason).toBe('cached_degrade');
    // and no log for a replay — the log lives in the catch, which did not run
    const logged = loggingMock.logToAxiom.mock.calls.map((c) => (c[0] as { type?: string }).type);
    expect(logged).not.toContain('resource-intent-degraded');
  });

  it('records the pinned model, spec hash and suggestion ids to ClickHouse', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(SHORTLIST);
    mockStage3({ '0': 0.7, '1': 0.2, none: 0.1 });
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );
    await getResourceIntent(INPUT, { ...CTX, now: () => new Date('2026-09-29T00:00:00.000Z') });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const call = mockInsert.mock.calls[0][0] as {
      table: string;
      format: string;
      values: Record<string, unknown>[];
    };
    expect(call.table).toBe('resourceIntentShadow');
    expect(call.format).toBe('JSONEachRow');
    const row = call.values[0];
    expect(row).toMatchObject({
      // 🔴 ClickHouse `DateTime64(3)` under `date_time_input_format = basic`:
      // space separator, no trailing `Z`. A raw toISOString() is REJECTED at
      // flush — and because the client sets `wait_for_async_insert: 0`, that
      // rejection never reaches us, so the table would just stay empty.
      // Pinned as a literal, not derived from the implementation.
      time: '2026-09-29 00:00:00.000',
      model: 'typesafe/jev-1.13-20260917',
      degraded: 0,
      role: 'style',
      styleFamily: 'anime_manga',
      contentType: 'portrait_character',
      specificity: 3,
      needsResource: 0.9,
      injectionPresent: 0,
      shortlistCount: 2,
      suggestionIds: [11, 22],
      noneProbability: 0.1,
      browsingLevel: 3,
      specVersion: 1,
      criteriaVersion: 1,
    });
    expect(row.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).not.toHaveProperty('prompt');
  });

  it('degrades the shadow row instead of failing the request when ClickHouse is down', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    mockInsert.mockRejectedValue(new Error('clickhouse down'));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-shadow-write-failed' }),
      'temp-search'
    );
  });

  it('falls back to the structured log when ClickHouse is not wired at all', async () => {
    clickhouseHolder.client = undefined;
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    await getResourceIntent(INPUT, CTX);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource-intent-shadow',
        model: 'typesafe/jev-1.13-20260917',
      }),
      'temp-search'
    );
  });

  it('a cache-hit shadow row records the hydrated suggestion count as shortlistCount', async () => {
    const cached = {
      degraded: false,
      intent: {
        needsResource: 0.9,
        role: { value: 'style', distribution: { style: 1 } },
        styleFamily: { value: 'anime_manga', distribution: { anime_manga: 1 } },
        contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
        specificity: 3,
        injectionPresent: 0,
      },
      criteria: {
        criteriaVersion: 1,
        specHash: 'a'.repeat(64),
        role: 'style',
        modelTypes: ['LORA'],
        baseModel: null,
      },
      suggestions: [
        {
          versionId: 31,
          modelId: 3,
          modelName: 'm',
          versionName: 'v',
          baseModel: 'SDXL 1.0',
          modelType: 'LORA',
          strength: 1,
          minStrength: -1,
          maxStrength: 2,
          trainedWords: [],
          clipSkip: null,
        },
      ],
      noneProbability: 0.1,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 1,
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);
    await getResourceIntent(INPUT, CTX);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = (mockInsert.mock.calls[0][0] as { values: Record<string, unknown>[] }).values[0];
    expect(row.shortlistCount).toBe(1);
    expect(row.suggestionIds).toEqual([31]);
  });
});

describe('degradation reasons', () => {
  it('a Jev timeout propagates its kind into the degraded-reason log', async () => {
    const { JevError } = await import('~/server/services/ai/jev');
    mockAskJev.mockRejectedValue(new JevError('timeout', 'Jev call exceeded 2000ms'));
    await getResourceIntent(INPUT, CTX);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-degraded', degradedReason: 'jev_timeout' }),
      'temp-search'
    );
  });

  it('a stage-1 answer shape mismatch degrades as jev_stage1_shape', async () => {
    // The Jev client would never return this (it validates per question); the
    // service re-checks so a spec desync degrades instead of shipping.
    mockAskJev.mockImplementationOnce(async () => ({
      answers: STAGE1_ANSWERS.map((a) =>
        a.id === 'role' ? { id: 'role', type: 'noul', value: 0.5 } : a
      ),
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'typesafe/jev-1.13-20260917',
    }));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ degradedReason: 'jev_stage1_shape' }),
      'temp-search'
    );
  });
});

describe('coverage resolution', () => {
  it('resolves coverageAudience itself when the caller does not supply one', async () => {
    const coverageSource = await import('~/server/services/generation/coverage-source');
    vi.mocked(coverageSource.coverageAudience).mockClear();
    mockStage1();
    mockFindCandidates.mockResolvedValue([]);
    await getResourceIntent(INPUT, { browsingLevel: 3 });
    expect(coverageSource.coverageAudience).toHaveBeenCalledTimes(1);
    // The resolved audience reached the matcher.
    expect(mockFindCandidates.mock.calls[0][1]).toMatchObject({
      coverage: { next: false, member: false },
    });
  });

  it('does not resolve coverage on a cache hit', async () => {
    const coverageSource = await import('~/server/services/generation/coverage-source');
    vi.mocked(coverageSource.coverageAudience).mockClear();
    redisMock.redis.packed.get.mockResolvedValue({
      degraded: false,
      intent: null,
      criteria: null,
      suggestions: [],
      noneProbability: null,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 1,
    });
    await getResourceIntent(INPUT, { browsingLevel: 3 });
    expect(coverageSource.coverageAudience).not.toHaveBeenCalled();
  });
});
