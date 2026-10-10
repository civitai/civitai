import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as JevModule from '~/server/services/ai/jev';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as CoocHolder from '~/server/services/resource-intent-cooc/holder';
import type * as MatcherModule from '~/server/services/resource-intent-matcher.service';

/**
 * The POOL_MERGE arm of the resource-intent service: which arm runs, the cache key, the
 * no-snapshot fallback, study mode, and the shadow row. The matcher, the snapshot holder, Jev,
 * redis, hydration and ClickHouse are mocked at their seams; the seam test
 * (`resource-intent-pool-merge.seam.test.ts`) runs the matcher and merge for real.
 */

const mockAskJev = vi.fn();
const mockFindCandidates = vi.fn();
const mockPoolMerge = vi.fn();
const mockGetResourceData = vi.fn();
const mockInsert = vi.fn();
const mockHolderResolve = vi.fn();
const mockStudyGet = vi.fn();

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-matcher.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MatcherModule>()),
  findResourceIntentCandidates: (...args: unknown[]) => mockFindCandidates(...(args as [])),
  findPoolMergeCandidates: (...args: unknown[]) => mockPoolMerge(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-cooc/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof CoocHolder>()),
  coocSnapshotHolder: () => ({ resolve: mockHolderResolve }),
  coocStudySnapshots: () => ({ get: mockStudyGet }),
}));
// Hand-listed for the reason resource-intent.service.test.ts records.
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return { insert: mockInsert };
  },
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const { getResourceIntent, resourceIntentCacheKey, COOC_FALLBACK_SNAPSHOT_KEY } = await import(
  '~/server/services/resource-intent.service'
);
const { RESOURCE_INTENT_SPEC_HASH } = await import('~/server/schema/resource-intent.schema');
const { RESOURCE_INTENT_STAGE3_SPEC_HASH } = await import(
  '~/server/services/resource-intent-stage3'
);
const { RESOURCE_INTENT_COOC_SPEC, RESOURCE_INTENT_COOC_SPEC_HASH } = await import(
  '~/server/services/resource-intent-cooc/spec'
);
const { RESOURCE_INTENT_POOL_MERGE_SPEC_HASH } = await import(
  '~/server/services/resource-intent-pool-merge'
);
const { CoocCountAccumulator } = await import('~/server/services/resource-intent-cooc/build');
const { loadScores } = await import('~/server/services/resource-intent-cooc/score');

const PROMPT = 'zephyr portrait of a knight';
const INPUT = { prompt: PROMPT } as const;
const CTX = { browsingLevel: 3, coverage: { next: false, member: false } };
const SNAPSHOT = 'a'.repeat(64);
const STUDY = 'b'.repeat(64);

/**
 * `zephyr` co-occurs with model 707 in 5 rows and 808 in 3, but 707 is attached 20 more times
 * without it, so 808 (higher lift) ranks first — not the ascending-id order a tie would give.
 */
function scores() {
  const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  for (let i = 0; i < 5; i++) acc.add(['zephyr'], [[707, 'LORA']]);
  for (let i = 0; i < 3; i++) acc.add(['zephyr'], [[808, 'LORA']]);
  for (let i = 0; i < 20; i++) acc.add([], [[707, 'LORA']]);
  for (let i = 0; i < 192; i++) acc.add([], []);
  const {
    rawPairs: _p,
    rawVocab: _v,
    typeConflicts: _t,
    ...counts
  } = acc.finalize(RESOURCE_INTENT_COOC_SPEC);
  return loadScores(counts, { beta: RESOURCE_INTENT_COOC_SPEC.beta });
}
const SCORES = scores();

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

function mockStage1() {
  mockAskJev.mockImplementationOnce(async () => ({
    answers: STAGE1_ANSWERS,
    usage: { promptTokens: 100, completionTokens: 50 },
    model: 'typesafe/jev-1.13-20260917',
  }));
}

const entry = (versionId: number, modelId: number) => ({
  versionId,
  modelId,
  modelName: `m${modelId}`,
  versionName: 'v1',
  baseModel: 'SDXL 1.0',
  modelType: 'LORA',
  thumbsUpCount: 1,
});
const genResource = (id: number) => ({
  id,
  name: `version-${id}`,
  baseModel: 'SDXL 1.0',
  strength: 0.8,
  minStrength: -1,
  maxStrength: 2,
  trainedWords: [],
  clipSkip: 2,
  hasAccess: true,
  canGenerate: true,
  model: { id: 100 + id, name: `model-${id}`, type: 'LORA', nsfw: false, poi: false, userId: 1 },
  air: `air:${id}`,
});

const served = () => ({
  snapshot: { contentHash: SNAPSHOT, scores: SCORES },
  fallbackReason: null,
});
const fallback = (reason = 'no_snapshot') => ({ snapshot: null, fallbackReason: reason });

const keyOf = (terms: string[]) =>
  `packed:caches:jev-resource-intent:v1:${createHash('sha256')
    .update(terms.join('|'))
    .digest('hex')}`;
const BASE_TERMS = [
  'p',
  'SDXL 1.0',
  '3',
  '50',
  RESOURCE_INTENT_SPEC_HASH,
  RESOURCE_INTENT_STAGE3_SPEC_HASH,
];

const shadowRow = () =>
  (mockInsert.mock.calls[0][0] as { values: Record<string, unknown>[] }).values[0];
const flush = () => vi.waitFor(() => expect(mockInsert).toHaveBeenCalled());

beforeEach(() => {
  mockAskJev.mockReset();
  mockFindCandidates.mockReset();
  mockFindCandidates.mockResolvedValue({
    entries: [entry(11, 1)],
    insightFallback: false,
    promotableVersions: 0,
    pool: [entry(11, 1)],
    basePool: [],
  });
  mockPoolMerge.mockReset();
  mockPoolMerge.mockResolvedValue({ entries: [entry(21, 2), entry(22, 3)], coocGated: 1 });
  mockGetResourceData.mockReset();
  mockGetResourceData.mockImplementation(async (ids: number[]) => ids.map(genResource));
  mockInsert.mockReset();
  mockHolderResolve.mockReset();
  mockHolderResolve.mockResolvedValue(served());
  mockStudyGet.mockReset();
  mockStudyGet.mockResolvedValue({ contentHash: STUDY, scores: SCORES });
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
});

describe('cache key', () => {
  it('🔴 the POOL_MERGE key carries the arm, the snapshot and both specs; HYBRID_10 is unchanged', () => {
    const base = { prompt: 'p', baseModel: 'SDXL 1.0', browsingLevel: 3, cap: 50 };
    expect(resourceIntentCacheKey(base)).toBe(keyOf(BASE_TERMS));
    expect(resourceIntentCacheKey({ ...base, poolMerge: { snapshot: SNAPSHOT } })).toBe(
      keyOf([
        ...BASE_TERMS,
        'pool_merge',
        SNAPSHOT,
        RESOURCE_INTENT_COOC_SPEC_HASH,
        RESOURCE_INTENT_POOL_MERGE_SPEC_HASH,
      ])
    );
    expect(resourceIntentCacheKey({ ...base, poolMerge: { snapshot: STUDY } })).not.toBe(
      resourceIntentCacheKey({ ...base, poolMerge: { snapshot: SNAPSHOT } })
    );
    // Four distinct values, so a mutant that swaps one term for another cannot pass.
    expect(
      new Set([SNAPSHOT, RESOURCE_INTENT_COOC_SPEC_HASH, RESOURCE_INTENT_POOL_MERGE_SPEC_HASH]).size
    ).toBe(3);
  });

  it('the served snapshot is in the key the service reads and writes', async () => {
    mockStage1();
    await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    const expected = resourceIntentCacheKey({
      prompt: PROMPT,
      browsingLevel: 3,
      cap: 50,
      poolMerge: { snapshot: SNAPSHOT },
    });
    expect(redisMock.redis.packed.get).toHaveBeenCalledWith(expected);
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(expected);
  });

  it('a fallback response is keyed apart from any snapshot', async () => {
    mockHolderResolve.mockResolvedValue(fallback());
    mockStage1();
    await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
      resourceIntentCacheKey({
        prompt: PROMPT,
        browsingLevel: 3,
        cap: 50,
        poolMerge: { snapshot: COOC_FALLBACK_SNAPSHOT_KEY },
      })
    );
  });
});

describe('the merge spec hash', () => {
  // A change detector: the hash covers the merge constants and the merge's output on a fixture,
  // and the cache key relies on it moving when either does. Update the literal deliberately.
  it('is pinned', () => {
    expect(RESOURCE_INTENT_POOL_MERGE_SPEC_HASH).toBe(
      '2c1171c711b5c50f424ee0332c77a0c00102d9b37eee47bf593cc1be171c4d2b'
    );
  });
});

describe('flag off: HYBRID_10 exactly as before', () => {
  it('🔴 never touches the snapshot holder or the pool merge; response, key and shadow row unchanged', async () => {
    for (const ctx of [CTX, { ...CTX, poolMerge: false }]) {
      mockStage1();
      mockAskJev.mockImplementation(async () => ({
        answers: [
          {
            id: 'resourceVersion',
            type: 'choice' as const,
            value: '0',
            distribution: { '0': 0.9, none: 0.1 },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
        model: 'typesafe/jev-1.13-20260917',
      }));
      const result = await getResourceIntent(INPUT, ctx);
      await flush();
      expect(Object.keys(result)).toEqual([
        'degraded',
        'insightFallback',
        'intent',
        'criteria',
        'suggestions',
        'noneProbability',
        'model',
        'criteriaVersion',
      ]);
      expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
        resourceIntentCacheKey({ prompt: PROMPT, browsingLevel: 3, cap: 50 })
      );
      expect(Object.keys(shadowRow())).not.toContain('arm');
      expect(Object.keys(shadowRow())).not.toContain('coocFallback');
      mockInsert.mockClear();
      redisMock.redis.packed.set.mockClear();
      mockAskJev.mockReset();
    }
    expect(mockHolderResolve).not.toHaveBeenCalled();
    expect(mockStudyGet).not.toHaveBeenCalled();
    expect(mockPoolMerge).not.toHaveBeenCalled();
    expect(mockFindCandidates).toHaveBeenCalledTimes(2);
  });
});

describe('POOL_MERGE with a served snapshot', () => {
  it('one vendor call, co-occurrence candidates handed to the merge, 1h cache', async () => {
    mockStage1();
    const result = await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(mockAskJev).toHaveBeenCalledTimes(1);
    expect(mockFindCandidates).not.toHaveBeenCalled();
    expect(mockPoolMerge).toHaveBeenCalledTimes(1);
    expect(mockPoolMerge.mock.calls[0][1]).toMatchObject({ cap: 50, coocCandidates: [808, 707] });
    expect(result).toMatchObject({ degraded: false, coocFallback: false, insightFallback: false });
    expect(result.suggestions.map((s) => s.versionId)).toEqual([21, 22]);
    expect(result.noneProbability).toBe(0.1);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 3600 });
  });

  it('role none: no merge, empty suggestions, not degraded', async () => {
    mockAskJev.mockImplementationOnce(async () => ({
      answers: STAGE1_ANSWERS.map((a) =>
        a.id === 'role' ? { ...a, value: 'none', distribution: { none: 0.9, style: 0.1 } } : a
      ),
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'typesafe/jev-1.13-20260917',
    }));
    const result = await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(mockPoolMerge).not.toHaveBeenCalled();
    expect(result).toMatchObject({ degraded: false, coocFallback: false, suggestions: [] });
  });
});

describe('🔴 POOL_MERGE with no servable snapshot: BASE, flagged, 60 s, reason logged', () => {
  it('serves the merge with NO co-occurrence candidates (BASE top cap), coocFallback true', async () => {
    mockHolderResolve.mockResolvedValue(fallback('load_failed'));
    mockStage1();
    const result = await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(mockPoolMerge.mock.calls[0][1]).toMatchObject({ cap: 50, coocCandidates: [] });
    expect(result).toMatchObject({ degraded: false, coocFallback: true });
    expect(result.suggestions.map((s) => s.versionId)).toEqual([21, 22]);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    expect(redisMock.redis.packed.set.mock.calls[0][1]).toMatchObject({ coocFallback: true });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      { type: 'resource-intent-cooc-fallback', reason: 'load_failed' },
      'temp-search'
    );
    await flush();
    expect(shadowRow()).toMatchObject({
      arm: 'pool_merge',
      coocSnapshotHash: '',
      coocFallback: 1,
      coocFallbackReason: 'load_failed',
    });
  });

  it('a served snapshot does not log a fallback', async () => {
    mockStage1();
    await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-cooc-fallback' }),
      'temp-search'
    );
  });
});

describe('POOL_MERGE cache hit', () => {
  it('serves the cached list with no vendor call, no merge, no fallback log; the row keeps its arm', async () => {
    mockHolderResolve.mockResolvedValue(fallback('no_snapshot'));
    const cached = {
      degraded: false,
      insightFallback: false,
      coocFallback: true,
      intent: null,
      criteria: null,
      suggestions: [{ versionId: 21 }],
      noneProbability: null,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2,
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);
    const result = await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(result).toEqual(cached);
    expect(mockAskJev).not.toHaveBeenCalled();
    expect(mockPoolMerge).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-cooc-fallback' }),
      'temp-search'
    );
    await flush();
    expect(shadowRow()).toMatchObject({
      arm: 'pool_merge',
      coocFallback: 1,
      coocFallbackReason: 'no_snapshot',
      shortlistCount: 1,
    });
  });
});

describe('POOL_MERGE degrade', () => {
  it('a Jev failure on the fallback arm degrades and still reports coocFallback (60 s)', async () => {
    mockHolderResolve.mockResolvedValue(fallback('no_snapshot'));
    mockAskJev.mockRejectedValue(new Error('timeout'));
    const result = await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(result).toMatchObject({ degraded: true, coocFallback: true, suggestions: [] });
    expect(redisMock.redis.packed.set.mock.calls[0][1]).toMatchObject({ coocFallback: true });
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
  });

  it('a merge (search) failure degrades with a snapshot served too', async () => {
    mockStage1();
    mockPoolMerge.mockRejectedValue(new Error('search down'));
    const result = await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    expect(result).toMatchObject({ degraded: true, coocFallback: false, suggestions: [] });
  });
});

describe('🔴 study mode', () => {
  it('serves POOL_MERGE from the study snapshot, keyed by its hash, never asking the holder', async () => {
    mockStage1();
    const result = await getResourceIntent(INPUT, { ...CTX, coocSnapshotId: STUDY });
    expect(mockStudyGet.mock.calls[0][0]).toBe(STUDY);
    expect(mockHolderResolve).not.toHaveBeenCalled();
    expect(mockPoolMerge.mock.calls[0][1]).toMatchObject({ coocCandidates: [808, 707] });
    expect(result).toMatchObject({ degraded: false, coocFallback: false });
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
      resourceIntentCacheKey({
        prompt: PROMPT,
        browsingLevel: 3,
        cap: 50,
        poolMerge: { snapshot: STUDY },
      })
    );
  });

  it('fails closed when the study snapshot cannot be served — no vendor call, no cache, no fallback', async () => {
    mockStudyGet.mockRejectedValue(new Error('pin has passed'));
    redisMock.redis.packed.get.mockResolvedValue({ planted: true });
    const result = await getResourceIntent(INPUT, {
      ...CTX,
      poolMerge: true,
      coocSnapshotId: STUDY,
    });
    expect(result).toEqual({
      degraded: true,
      insightFallback: false,
      coocFallback: false,
      intent: null,
      criteria: null,
      suggestions: [],
      noneProbability: null,
      model: 'jev-unavailable',
      criteriaVersion: 2,
    });
    expect(mockAskJev).not.toHaveBeenCalled();
    expect(mockPoolMerge).not.toHaveBeenCalled();
    expect(mockHolderResolve).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource-intent-degraded',
        degradedReason: 'cooc_study_snapshot',
      }),
      'temp-search'
    );
    await flush();
    expect(shadowRow()).toMatchObject({
      degraded: 1,
      degradedReason: 'cooc_study_snapshot',
      arm: 'pool_merge',
      coocSnapshotHash: STUDY,
      coocFallback: 0,
    });
  });
});

describe('shadow row', () => {
  it('🔴 a POOL_MERGE row writes exactly the columns the three shadow migrations declare', async () => {
    const dir = path.resolve(__dirname, '../../clickhouse/migrations');
    const create = readFileSync(path.join(dir, '2026-09-29-resource-intent-shadow.sql'), 'utf8');
    const added = [
      '2026-10-08-resource-intent-shadow-stage3.sql',
      '2026-10-10-resource-intent-shadow-pool-merge.sql',
    ]
      .flatMap((f) => [
        ...readFileSync(path.join(dir, f), 'utf8').matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g),
      ])
      .map((m) => m[1]);
    const created = create
      .slice(create.indexOf('resourceIntentShadow\n(') + 'resourceIntentShadow\n('.length)
      .split('\n)\nENGINE')[0]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    expect(added.slice(3)).toEqual([
      'arm',
      'coocSnapshotHash',
      'coocSpecHash',
      'poolMergeSpecHash',
      'coocFallback',
      'coocFallbackReason',
    ]);

    mockStage1();
    await getResourceIntent(INPUT, { ...CTX, poolMerge: true });
    await flush();
    expect(new Set(Object.keys(shadowRow()))).toEqual(new Set([...created, ...added]));
    expect(shadowRow()).toMatchObject({
      arm: 'pool_merge',
      coocSnapshotHash: SNAPSHOT,
      coocSpecHash: RESOURCE_INTENT_COOC_SPEC_HASH,
      poolMergeSpecHash: RESOURCE_INTENT_POOL_MERGE_SPEC_HASH,
      coocFallback: 0,
      coocFallbackReason: '',
      stage3NoneProbability: null,
      shortlistCount: 2,
    });
  });
});
