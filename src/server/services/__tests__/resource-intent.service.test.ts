import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as JevModule from '~/server/services/ai/jev';
import type * as SchemaModule from '~/server/schema/resource-intent.schema';

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

const { getResourceIntent, resolveSuggestionLimit, resourceIntentCacheKey } = await import(
  '~/server/services/resource-intent.service'
);

/**
 * The matcher's RESULT shape. It returns a result object rather than a bare array
 * precisely so its fail-soft path is not silent at this seam, and the default here is
 * the success case — a test that wants the fallback passes `true`. `pool` defaults to
 * the entries themselves (popularity order = shortlist order) and `basePool` to empty,
 * so the suggestions are exactly stage 3's head unless a test supplies a fill.
 */
const matched = (
  entries: unknown[],
  insightFallback = false,
  extra: { pool?: unknown[]; basePool?: unknown[] } = {}
) => ({
  entries,
  insightFallback,
  promotableVersions: 0,
  pool: extra.pool ?? entries,
  basePool: extra.basePool ?? [],
});

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

type ShortlistFixture = {
  versionId: number;
  modelName: string;
  versionName: string;
  modelType: string;
  baseModel: string;
};
type Stage3Request = {
  state: Record<string, string>;
  questions: { options: string[]; optionDescriptions?: Record<string, string> }[];
};

/** The description the vendor saw for `option`. */
function describedAs(question: Stage3Request['questions'][number], option: string) {
  return question.optionDescriptions?.[option];
}

function stage3Responder(
  byVersion: Record<number, number>,
  none = 0,
  shortlist: ShortlistFixture[] = SHORTLIST
) {
  return async (request: Stage3Request) => {
    const question = request.questions[0];
    const distribution: Record<string, number> = { none };
    for (const option of question.options) {
      if (option === 'none') continue;
      const sent = shortlist.find(
        (e) =>
          `${e.modelName} — ${e.versionName} (${e.modelType}, ${e.baseModel})` ===
          describedAs(question, option)
      );
      if (!sent) throw new Error(`stage-3 mock: unknown option ${option}`);
      distribution[option] = byVersion[sent.versionId] ?? 0;
    }
    const value = Object.entries(distribution).sort((a, b) => b[1] - a[1])[0][0];
    return {
      answers: [{ id: 'resourceVersion', type: 'choice' as const, value, distribution }],
      usage: { promptTokens: 200, completionTokens: 20 },
      model: 'typesafe/jev-1.13-20260917',
    };
  };
}

/**
 * Answers BOTH stage-3 calls (one per option order) with each VERSION's probability,
 * whatever position it was sent in — so the averaged order is the `byVersion` order and
 * a test reads the same whichever order the service sends first.
 */
function mockStage3(
  byVersion: Record<number, number>,
  none = 0,
  shortlist: ShortlistFixture[] = SHORTLIST
) {
  const respond = stage3Responder(byVersion, none, shortlist);
  mockAskJev.mockImplementationOnce(respond);
  mockAskJev.mockImplementationOnce(respond);
}

beforeEach(() => {
  clickhouseHolder.client = { insert: mockInsert };
  mockAskJev.mockReset();
  mockFindCandidates.mockReset();
  mockFindCandidates.mockResolvedValue(matched([]));
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

describe('resolveSuggestionLimit — the one shortlist bound', () => {
  // The matcher used to clamp separately, and the two disagreed about exactly these
  // inputs: `Math.min(limit, MAX)` alone passes 0, negatives and fractions straight
  // through.
  //
  // ⚠️ Invariant guard, and labelled as one: the only production caller of
  // `getResourceIntent` is the REST route, which parses through
  // `resourceIntentInputSchema` (`int().min(1).max(255)`), so 0, -4 and 9.8 are
  // unreachable today. This pins the consolidated clamp against the next caller —
  // it is NOT evidence of a live hole that was closed.
  it('floors at 1, truncates, and caps at the maximum', async () => {
    const { RESOURCE_INTENT_MAX_SHORTLIST, RESOURCE_INTENT_DEFAULT_LIMIT } = await import(
      '~/server/schema/resource-intent.schema'
    );
    expect(resolveSuggestionLimit(undefined)).toBe(RESOURCE_INTENT_DEFAULT_LIMIT);
    expect(resolveSuggestionLimit(7)).toBe(7);
    expect(resolveSuggestionLimit(0)).toBe(1);
    expect(resolveSuggestionLimit(-4)).toBe(1);
    expect(resolveSuggestionLimit(9.8)).toBe(9);
    expect(resolveSuggestionLimit(1000)).toBe(RESOURCE_INTENT_MAX_SHORTLIST);
  });
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

  it('🔴 the spec term in the key is the spec HASH, not the hand-maintained version', async () => {
    // Recomputed independently, so swapping the term back to
    // `String(QUESTION_SPEC_VERSION)` goes red. The hash moves on ANY question-spec
    // edit; the integer only moves when someone remembers. Measured once: rewording
    // the `specificity` prompt moved the hash and left the version at 1, so a
    // pre-edit cache entry would have been served for its full hour under the new
    // spec and then stamped into the shadow table with the NEW hash.
    const { RESOURCE_INTENT_SPEC_HASH, QUESTION_SPEC_VERSION } = await import(
      '~/server/schema/resource-intent.schema'
    );
    const { RESOURCE_INTENT_STAGE3_SPEC_HASH } = await import(
      '~/server/services/resource-intent-stage3'
    );
    const base = { prompt: 'p', baseModel: 'SDXL 1.0', browsingLevel: 3, cap: 50 };
    const expected = createHash('sha256')
      .update(
        [
          'p',
          'SDXL 1.0',
          '3',
          '50',
          RESOURCE_INTENT_SPEC_HASH,
          RESOURCE_INTENT_STAGE3_SPEC_HASH,
        ].join('|')
      )
      .digest('hex');
    expect(resourceIntentCacheKey(base)).toBe(`packed:caches:jev-resource-intent:v1:${expected}`);
    // And the control: the version integer is NOT what the key carries.
    const withVersion = createHash('sha256')
      .update(
        [
          'p',
          'SDXL 1.0',
          '3',
          '50',
          String(QUESTION_SPEC_VERSION),
          RESOURCE_INTENT_STAGE3_SPEC_HASH,
        ].join('|')
      )
      .digest('hex');
    expect(resourceIntentCacheKey(base)).not.toBe(
      `packed:caches:jev-resource-intent:v1:${withVersion}`
    );
  });

  it('🔴 never serves more suggestions than the caller asked for, even from a wider entry', async () => {
    // An entry written under an OLDER key shape (i.e. at a wider cap) landing on
    // this request's key is the case the key change alone cannot fix — the
    // serve-time truncation is what holds the contract. Planted directly.
    const wide = {
      degraded: false,
      insightFallback: false,
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
        criteriaVersion: 2 as const,
        specHash: 'abc',
        role: 'style' as const,
        styleFamily: 'anime_manga' as const,
        modelTypes: ['LORA' as const],
        baseModel: null,
      },
      suggestions: [{ versionId: 11 }, { versionId: 22 }, { versionId: 33 }],
      noneProbability: 0.1,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2 as const,
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
    mockStage3({ 11: 0.6, 22: 0.4 });
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockGetResourceData.mockResolvedValue([genResource(11), genResource(22)]);

    const result = await getResourceIntent({ ...INPUT, limit: 1 }, CTX);

    expect(mockFindCandidates.mock.calls[0][1]).toMatchObject({ cap: 1 });
    expect(result.suggestions).toHaveLength(1);
  });

  it('a cache hit short-circuits both Jev calls and is NOT rewritten', async () => {
    const cached = {
      degraded: false,
      insightFallback: false,
      intent: {
        needsResource: 0.9,
        role: { value: 'style', distribution: { style: 1 } },
        styleFamily: { value: 'anime_manga', distribution: { anime_manga: 1 } },
        contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
        specificity: 3,
        injectionPresent: 0,
      },
      criteria: {
        criteriaVersion: 2,
        specHash: 'abc',
        role: 'style',
        styleFamily: 'anime_manga',
        modelTypes: ['LORA'],
        baseModel: null,
      },
      suggestions: [],
      noneProbability: 0.1,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2,
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);

    const result = await getResourceIntent(INPUT, CTX);

    expect(mockAskJev).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    expect(result).toEqual(cached);
  });

  it('🔴 a well-formed PRE-BUMP entry is recomputed, not served', async () => {
    // The cache key is unchanged by this bump — it carries the question spec hash,
    // which did not move — so every live entry keeps its key and only the response
    // parse rejects it. The sibling test below plants garbage; this plants the one
    // blob shape that actually sits in Redis today, which is the only thing standing
    // between a cached prompt and an hour of un-ordered suggestions.
    const v1Criteria = {
      criteriaVersion: 1,
      specHash: 'a'.repeat(64),
      role: 'style',
      modelTypes: ['LORA'],
      baseModel: null,
    };
    const v1Intent = {
      needsResource: 0.9,
      role: { value: 'style', distribution: { style: 1 } },
      styleFamily: { value: 'anime_manga', distribution: { anime_manga: 1 } },
      contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
      specificity: 3,
      injectionPresent: 0,
    };
    redisMock.redis.packed.get.mockResolvedValue({
      degraded: false,
      insightFallback: false,
      intent: v1Intent,
      criteria: v1Criteria,
      suggestions: [{ versionId: 999 }],
      noneProbability: 0.1,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 1,
    });
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched([]));

    const result = await getResourceIntent(INPUT, CTX);

    expect(mockAskJev).toHaveBeenCalledTimes(1);
    expect(result.criteriaVersion).toBe(2);
    expect(result.suggestions).toEqual([]);

    // 🔴 The parse has THREE independently sufficient terms — `criteria.criteriaVersion`,
    // the response-root `criteriaVersion`, and `criteria.styleFamily` being required —
    // so the blob above cannot attribute the rejection to any one of them, and relaxing
    // any ONE leaves it passing. Each arm below plants a blob only one term can reject.
    const stale = async (blob: Record<string, unknown>) => {
      mockAskJev.mockReset();
      mockStage1();
      redisMock.redis.packed.get.mockResolvedValue(blob);
      const out = await getResourceIntent(INPUT, CTX);
      expect(mockAskJev).toHaveBeenCalledTimes(1);
      expect(out.suggestions).toEqual([]);
    };

    const current = {
      degraded: false,
      insightFallback: false,
      intent: v1Intent,
      criteria: { ...v1Criteria, criteriaVersion: 2, styleFamily: 'anime_manga' },
      suggestions: [{ versionId: 999 }],
      noneProbability: 0.1,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2,
    };

    // 🔴 POSITIVE CONTROL, and it is what makes the three single-term arms below mean
    // anything: each of those is `current` with ONE term spoiled, so if `current`
    // itself stops parsing — the response schema is strict, so the next required
    // field does that — they would all still be recomputed, for the wrong reason, and
    // stay green. It does NOT cover the fourth arm, which is a different blob shape
    // (degraded, `criteria: null`); that one's own parse is pinned by the
    // `shadow event` test that plants the same shape at the current version and
    // asserts it IS served.
    mockAskJev.mockReset();
    redisMock.redis.packed.get.mockResolvedValue(current);
    const served = await getResourceIntent(INPUT, CTX);
    expect(mockAskJev).not.toHaveBeenCalled();
    expect(served.suggestions).toEqual([{ versionId: 999 }]);

    // Only the ROOT literal can reject this one.
    await stale({ ...current, criteriaVersion: 1 });
    // Only the CRITERIA literal can reject this one.
    await stale({ ...current, criteria: { ...current.criteria, criteriaVersion: 1 } });
    // Only the required-field term can reject this one.
    await stale({
      ...current,
      criteria: (({ styleFamily: _dropped, ...rest }) => rest)(current.criteria),
    });
    // 🔴 And the shape where the root literal is the ONLY reachable gate, because
    // `criteria` is nullable and both criteria-side terms are structurally
    // unreachable: a DEGRADED pre-bump entry, which is a real production blob on
    // the 60s TTL path.
    await stale({
      degraded: true,
      insightFallback: false,
      intent: null,
      criteria: null,
      suggestions: [],
      noneProbability: null,
      model: 'jev-unavailable',
      criteriaVersion: 1,
    });
  });

  it('a corrupted cached blob is ignored and recomputed', async () => {
    redisMock.redis.packed.get.mockResolvedValue({ not: 'a response' });
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched([]));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(mockAskJev).toHaveBeenCalledTimes(1);
  });

  it('a cache read failure is a miss, never an error', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('redis down'));
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched([]));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
  });

  it('a successful response caches for 1h; a degraded one for 60s', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched([]));
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

  // 🔴 The matcher's label-read fallback gets the SHORT TTL, and it is not degraded.
  // Red before the fix with `EX: 3600`: the matcher swallowed its own fallback, so
  // the service had no way to tell an unordered response from an ordered one and
  // pinned the unordered one to this cache key for an hour — while the analogous
  // vendor failure above got 60s.
  //
  // The two arms differ ONLY in the matcher's flag: same prompt, same stage-1, same
  // stage-3, same shortlist. So nothing but the flag can move the TTL, and the
  // control arm is what stops `EX: 60` unconditionally from passing.
  it('🔴 a label-read fallback caches for 60s, and is NOT reported as degraded', async () => {
    mockStage1();
    mockStage3({ 11: 0.6, 22: 0.4 });
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST, true));
    mockGetResourceData.mockResolvedValue([genResource(11), genResource(22)]);

    const fallback = await getResourceIntent(INPUT, CTX);

    expect(redisMock.redis.packed.set).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    // Not a degrade: real suggestions, a real intent, and the vendor's own model.
    expect(fallback.degraded).toBe(false);
    expect(fallback.insightFallback).toBe(true);
    expect(fallback.suggestions.map((s) => s.versionId)).toEqual([11, 22]);
    expect(fallback.model).toBe('typesafe/jev-1.13-20260917');
    // 🔴 The flag rides INSIDE the cached blob, so a replay reports what the
    // computation did. Asserted on the value handed to redis, not on the return.
    expect(redisMock.redis.packed.set.mock.calls[0][1]).toMatchObject({
      insightFallback: true,
    });

    // Control arm: the identical request with the labels read successfully.
    redisMock.redis.packed.set.mockClear();
    mockAskJev.mockReset();
    mockStage1();
    mockStage3({ 11: 0.6, 22: 0.4 });
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));

    const ok = await getResourceIntent(INPUT, CTX);

    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 3600 });
    expect(ok.insightFallback).toBe(false);
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
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.7, 22: 0.2 }, 0.1);
    mockGetResourceData.mockRejectedValue(new Error('db down'));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(true);
    expect(result.suggestions).toEqual([]);
    // Stage 3 DID run before hydration failed; a degraded row still carries no stage-3 none.
    const row = (mockInsert.mock.calls[0][0] as { values: Record<string, unknown>[] }).values[0];
    expect(row.stage3NoneProbability).toBeNull();
    expect(row.stage1NoneProbability).toBeNull();
  });

  // 🔴 The two failures COMBINED, which is the only path on which `insightFallback`
  // is tracked outside the `try` — and the line that tracking exists for had no
  // coverage at all: `insightFallback` → `false` in the degraded literal was green
  // across the whole suite. The TTL cannot see it (a degrade is already short-lived),
  // so what this pins is the CACHED BLOB, which is the one property the field's own
  // docstring says it exists for — a replay has to report what the computation did.
  //
  // It is also the fixture that makes the scoping honest: `insightFallback: true`
  // here arrives with `suggestions: []`, so anything claiming the flag implies
  // suggestions is false, and the comments now say "only interpretable when
  // `degraded` is false" because of this case.
  it('🔴 a label-read fallback followed by a LATER failure degrades, and still records the fallback', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST, true));
    mockStage3({ 11: 0.7, 22: 0.2 }, 0.1);
    mockGetResourceData.mockRejectedValue(new Error('db down'));

    const result = await getResourceIntent(INPUT, CTX);

    expect(result.degraded).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(result.insightFallback).toBe(true);
    // Asserted on what reached redis, not only the return value.
    expect(redisMock.redis.packed.set.mock.calls[0][1]).toMatchObject({
      degraded: true,
      insightFallback: true,
    });

    // Control: the identical degrade WITHOUT a label-read failure records `false`.
    // Without this arm, hardcoding `true` in the degraded literal passes.
    redisMock.redis.packed.set.mockClear();
    mockAskJev.mockReset();
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.7, 22: 0.2 }, 0.1);

    const plain = await getResourceIntent(INPUT, CTX);

    expect(plain.degraded).toBe(true);
    expect(plain.insightFallback).toBe(false);
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
    mockFindCandidates.mockResolvedValue(matched([]));
    const result = await getResourceIntent({ ...INPUT, baseModel: 'SDXL 1.0' }, CTX);
    expect(result.criteria).toEqual({
      criteriaVersion: 2,
      specHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      role: 'style',
      styleFamily: 'anime_manga',
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
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 22: 0.6, 11: 0.3 }, 0.1);
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
    // Hydration is called with the DISTRIBUTION order, not the shortlist's seed order.
    expect(mockGetResourceData.mock.calls[0][0]).toEqual([22, 11]);
  });

  it('🔴 a stage-3 "none" argmax KEEPS the list and reports the averaged none mass', async () => {
    // The arm screen measured "none argmax ⇒ empty" costing hit@10.
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.3, 22: 0.2 }, 0.5);
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([11, 22]);
    expect(result.noneProbability).toBe(0.5);
  });

  it('an empty shortlist skips stage 3 entirely (no forced fits)', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched([]));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect(mockAskJev).toHaveBeenCalledTimes(1);
  });

  it('an empty shortlist with a popularity pool returns the pool top cap, no stage 3', async () => {
    mockStage1();
    const base = [31, 32, 33].map((n) => ({ ...SHORTLIST[0], versionId: n, modelId: n }));
    mockFindCandidates.mockResolvedValue(matched([], false, { basePool: base }));
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );
    const result = await getResourceIntent({ ...INPUT, limit: 2 }, CTX);
    expect(mockAskJev).toHaveBeenCalledTimes(1);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([31, 32]);
    expect(result.noneProbability).toBe(0.1);
  });

  it('🔴 stage 3 is TWO calls: popularity order and its reverse, state {prompt, role, styleFamily}', async () => {
    // Shortlist in RE-RANK order 22, 11; the seed pool (popularity) has 11 first. So the
    // popularity call sends 11 then 22, and the reverse call 22 then 11.
    mockStage1();
    mockFindCandidates.mockResolvedValue(
      matched([SHORTLIST[1], SHORTLIST[0]], false, { pool: [SHORTLIST[0], SHORTLIST[1]] })
    );
    mockStage3({ 11: 0.5, 22: 0.5 });
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );
    const result = await getResourceIntent(INPUT, CTX);

    expect(mockAskJev).toHaveBeenCalledTimes(3);
    const stage3 = mockAskJev.mock.calls.slice(1).map((c) => c[0] as Stage3Request);
    expect(stage3.map((r) => r.state)).toEqual([
      { prompt: INPUT.prompt, role: 'style', styleFamily: 'anime_manga' },
      { prompt: INPUT.prompt, role: 'style', styleFamily: 'anime_manga' },
    ]);
    expect(stage3.map((r) => r.questions[0].optionDescriptions)).toEqual([
      {
        '0': 'LoRA One — v1 (LORA, SDXL 1.0)',
        '1': 'LoRA Two — v1 (LORA, SDXL 1.0)',
        none: 'None of the listed resources fits: each is the wrong character, subject, style or purpose for this prompt.',
      },
      {
        '0': 'LoRA Two — v1 (LORA, SDXL 1.0)',
        '1': 'LoRA One — v1 (LORA, SDXL 1.0)',
        none: 'None of the listed resources fits: each is the wrong character, subject, style or purpose for this prompt.',
      },
    ]);
    // Both average 0.5: the tie goes to the SHORTLIST (re-rank) order, 22 before 11.
    expect(result.suggestions.map((s) => s.versionId)).toEqual([22, 11]);
  });

  it('either stage-3 call failing degrades the whole response (fail closed)', async () => {
    const { JevError } = await import('~/server/services/ai/jev');
    for (const failing of [0, 1]) {
      mockAskJev.mockReset();
      loggingMock.logToAxiom.mockClear();
      mockStage1();
      mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
      const answer = stage3Responder({ 11: 0.7, 22: 0.2 }, 0.1);
      const timeout = async () => {
        throw new JevError('timeout', 'Jev call exceeded 2000ms');
      };
      mockAskJev.mockImplementationOnce(failing === 0 ? timeout : answer);
      mockAskJev.mockImplementationOnce(failing === 1 ? timeout : answer);

      const result = await getResourceIntent(INPUT, CTX);

      expect(mockAskJev).toHaveBeenCalledTimes(3);
      expect(result.degraded).toBe(true);
      expect(result.suggestions).toEqual([]);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'resource-intent-degraded',
          degradedReason: 'jev_timeout',
        }),
        'temp-search'
      );
    }
  });

  it('🔴 HYBRID_10: stage 3 picks the first 10 distinct MODELS, the popularity pool fills to the cap', async () => {
    // 12 shortlist versions over 11 models (model 1 twice), and a popularity pool whose
    // first entry repeats a head model. Every probability is distinct, so the head order
    // is the probability order.
    const shortlist = Array.from({ length: 12 }, (_, i) => ({
      ...SHORTLIST[0],
      versionId: 100 + i,
      modelId: i === 1 ? 1 : i + 1,
      modelName: `Head ${i}`,
    }));
    const byVersion = Object.fromEntries(shortlist.map((e, i) => [e.versionId, (12 - i) / 100]));
    const basePool = [
      { ...SHORTLIST[0], versionId: 900, modelId: 3, modelName: 'Base 3' },
      ...Array.from({ length: 60 }, (_, i) => ({
        ...SHORTLIST[0],
        versionId: 1000 + i,
        modelId: 500 + i,
        modelName: `Base ${i}`,
      })),
    ];
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched(shortlist, false, { basePool }));
    mockStage3(byVersion, 0.22, shortlist);
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );

    const result = await getResourceIntent(INPUT, CTX);
    const versionIds = result.suggestions.map((s) => s.versionId);

    expect(versionIds).toHaveLength(50);
    // Head: versions 100..111 minus 101 (model 1 again) → the first 10 distinct models.
    expect(versionIds.slice(0, 10)).toEqual([100, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    // Fill: 900 is model 3, already placed, so the fill starts at 1000 and runs 40 deep.
    expect(versionIds[10]).toBe(1000);
    expect(versionIds[49]).toBe(1039);
    expect(versionIds).not.toContain(900);
    expect(versionIds).not.toContain(111);
  });

  it('hydration re-applies the gates: a non-public version is dropped, not shipped', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.7, 22: 0.2 }, 0.1);
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
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.7, 22: 0.2 }, 0.1);
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
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.7, 22: 0.2 }, 0.1);
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
      insightFallback: false,
      intent: null,
      criteria: null,
      suggestions: [],
      noneProbability: null,
      model: 'jev-unavailable',
      criteriaVersion: 2,
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
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.4, 22: 0.3 }, 0.3);
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
      // Stage 1's role.none (0.1) and stage 3's averaged none (0.3), in their OWN columns;
      // distinct values, so a swap of the two columns goes red.
      noneProbability: 0.3,
      stage1NoneProbability: 0.1,
      stage3NoneProbability: 0.3,
      browsingLevel: 3,
      specVersion: 1,
      criteriaVersion: 2,
    });
    expect(row.specHash).toMatch(/^[0-9a-f]{64}$/);
    const { RESOURCE_INTENT_STAGE3_SPEC_HASH } = await import(
      '~/server/services/resource-intent-stage3'
    );
    expect(row.stage3SpecHash).toBe(RESOURCE_INTENT_STAGE3_SPEC_HASH);
    expect(row.stage3SpecHash).not.toBe(row.specHash);
    expect(row.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).not.toHaveProperty('prompt');
  });

  it('🔴 writes exactly the columns the two shadow migrations declare', async () => {
    // A key the table lacks loses the row silently (async insert), so pin row ↔ DDL.
    const dir = path.resolve(__dirname, '../../clickhouse/migrations');
    const create = readFileSync(path.join(dir, '2026-09-29-resource-intent-shadow.sql'), 'utf8');
    const alter = readFileSync(
      path.join(dir, '2026-10-08-resource-intent-shadow-stage3.sql'),
      'utf8'
    );
    const created = create
      .slice(create.indexOf('resourceIntentShadow\n(') + 'resourceIntentShadow\n('.length)
      .split('\n)\nENGINE')[0]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    const added = [...alter.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(created).toHaveLength(21);
    expect(added).toEqual(['stage3SpecHash', 'stage1NoneProbability', 'stage3NoneProbability']);

    mockStage1();
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    mockStage3({ 11: 0.7, 22: 0.2 }, 0.1);
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => genResource(id))
    );
    await getResourceIntent(INPUT, CTX);
    const row = (mockInsert.mock.calls[0][0] as { values: Record<string, unknown>[] }).values[0];
    expect(new Set(Object.keys(row))).toEqual(new Set([...created, ...added]));
  });

  it('degrades the shadow row instead of failing the request when ClickHouse is down', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched([]));
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
    mockFindCandidates.mockResolvedValue(matched([]));
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
      insightFallback: false,
      intent: {
        needsResource: 0.9,
        role: { value: 'style', distribution: { style: 0.75, none: 0.25 } },
        styleFamily: { value: 'anime_manga', distribution: { anime_manga: 1 } },
        contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
        specificity: 3,
        injectionPresent: 0,
      },
      criteria: {
        criteriaVersion: 2,
        specHash: 'a'.repeat(64),
        role: 'style',
        styleFamily: 'anime_manga',
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
      criteriaVersion: 2,
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);
    await getResourceIntent(INPUT, CTX);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = (mockInsert.mock.calls[0][0] as { values: Record<string, unknown>[] }).values[0];
    expect(row.shortlistCount).toBe(1);
    expect(row.suggestionIds).toEqual([31]);
    // Stage 1's none comes from the cached intent; stage 3's is not cached, so a hit
    // records NULL rather than a value this request never computed.
    expect(row.stage1NoneProbability).toBe(0.25);
    expect(row.stage3NoneProbability).toBeNull();
    expect(row.noneProbability).toBe(0.1);
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

  it('a stage-3 answer of the wrong kind degrades as jev_stage3_shape', async () => {
    mockStage1();
    mockFindCandidates.mockResolvedValue(matched(SHORTLIST));
    const noul = async () => ({
      answers: [{ id: 'resourceVersion', type: 'noul' as const, value: 0.5 }],
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'typesafe/jev-1.13-20260917',
    });
    mockAskJev.mockImplementationOnce(noul);
    mockAskJev.mockImplementationOnce(noul);
    const result = await getResourceIntent(INPUT, CTX);
    expect(result.degraded).toBe(true);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ degradedReason: 'jev_stage3_shape' }),
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
    mockFindCandidates.mockResolvedValue(matched([]));
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
      insightFallback: false,
      intent: null,
      criteria: null,
      suggestions: [],
      noneProbability: null,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2,
    });
    await getResourceIntent(INPUT, { browsingLevel: 3 });
    expect(coverageSource.coverageAudience).not.toHaveBeenCalled();
  });
});

// Last in the file: it re-imports the service under a doctored schema.
describe('stage-3 spec hash in the cache key', () => {
  it('🔴 rewording stage 3 moves the cache key; an identical re-import does not', async () => {
    const input = { prompt: 'p', baseModel: 'SDXL 1.0', browsingLevel: 3, cap: 50 };
    const keyWith = async (overrides: Record<string, string>) => {
      vi.resetModules();
      vi.doMock('~/server/schema/resource-intent.schema', async (importOriginal) => ({
        ...(await importOriginal<typeof SchemaModule>()),
        ...overrides,
      }));
      const fresh = await import('~/server/services/resource-intent.service');
      vi.doUnmock('~/server/schema/resource-intent.schema');
      return fresh.resourceIntentCacheKey(input);
    };
    const current = resourceIntentCacheKey(input);
    // Control: the re-import machinery alone does not move the key.
    expect(await keyWith({})).toBe(current);
    expect(
      await keyWith({ RESOURCE_INTENT_STAGE3_INSTRUCTIONS: 'Which listed resource fits best?' })
    ).not.toBe(current);
    expect(
      await keyWith({ RESOURCE_INTENT_STAGE3_NONE_DESCRIPTION: 'Nothing listed fits.' })
    ).not.toBe(current);
  });
});
