import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as JevModule from '~/server/services/ai/jev';
import type * as MeiliClient from '~/server/meilisearch/client';

/**
 * The insight seam ACROSS both modules: prompt → stage-1 intent → the real matcher
 * (real Meilisearch filter + expansion + label ordering) → stage 3 → hydration.
 *
 * `resource-intent.service.test.ts` mocks the matcher and
 * `resource-intent-matcher.service.test.ts` never runs the service, so neither can
 * see a response whose order is decided by a label. Only the vendor, the search
 * client and resource hydration are mocked here.
 */

const mockAskJev = vi.fn();
const mockGetResourceData = vi.fn();
const searchWithSignal = vi.fn();

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
}));

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({}) },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));

// Hand-listed for the same reason resource-intent.service.test.ts hand-lists it:
// generation.service is a hub whose transitive graph this suite does not want.
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const { getResourceIntent } = await import('~/server/services/resource-intent.service');

const INPUT = { prompt: 'an anime portrait of a swordswoman', baseModel: 'SDXL 1.0' } as const;
const CTX = { browsingLevel: 3, coverage: { next: false, member: false } };

const STAGE1_ANSWERS = [
  { id: 'needsResource', type: 'noul' as const, value: 0.9 },
  { id: 'role', type: 'choice' as const, value: 'style', distribution: { style: 1 } },
  {
    id: 'styleFamily',
    type: 'choice' as const,
    value: 'anime_manga',
    distribution: { anime_manga: 1 },
  },
  {
    id: 'contentType',
    type: 'choice' as const,
    value: 'portrait_character',
    distribution: { portrait_character: 1 },
  },
  { id: 'specificity', type: 'score' as const, value: 4 },
  { id: 'injectionPresent', type: 'noul' as const, value: 0 },
];

const hitFor = (modelId: number, versionId: number, thumbsUpCount: number) =>
  ({
    id: modelId,
    name: `model-${modelId}`,
    type: 'LORA',
    metrics: { thumbsUpCount },
    versions: [{ id: versionId, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
  } as never);

const genResource = (id: number) => ({
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
});

// Served as the seed page, so this is the seed order.
const SEED_HITS = [hitFor(8801, 81001, 94), hitFor(8802, 82002, 57), hitFor(8803, 83003, 19)];

beforeEach(() => {
  mockAskJev.mockReset();
  mockAskJev.mockImplementationOnce(async () => ({
    answers: STAGE1_ANSWERS,
    usage: { promptTokens: 100, completionTokens: 50 },
    model: 'typesafe/jev-1.13-20260917',
  }));
  // A FLAT stage-3 distribution for BOTH stage-3 calls, so stage 3 reorders nothing
  // and what the response carries is the order the matcher produced.
  mockAskJev.mockImplementation(async () => ({
    answers: [
      {
        id: 'resourceVersion',
        type: 'choice' as const,
        value: '0',
        distribution: { '0': 0.25, '1': 0.25, '2': 0.25 },
      },
    ],
    usage: { promptTokens: 200, completionTokens: 20 },
    model: 'typesafe/jev-1.13-20260917',
  }));

  mockGetResourceData.mockReset();
  mockGetResourceData.mockImplementation(async (ids: number[]) => ids.map(genResource));

  searchWithSignal.mockReset();
  searchWithSignal.mockResolvedValue({ hits: SEED_HITS, estimatedTotalHits: 3 });

  dbMock.dbRead.resourceInsight.findMany.mockReset();
  dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);

  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');

  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

describe('resource-intent — a label changes the served response', () => {
  it('🔴 serves the least popular candidate first when its label agrees with the prompt', async () => {
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      // The most popular candidate disagrees on both axes above the demote floor, and
      // carries the best qualityScore of the three, so neither popularity nor quality
      // can produce the asserted order.
      {
        modelVersionId: 81001,
        role: 'quality_enhancer',
        styleFamily: 'pixel_retro',
        confidence: 0.72,
        qualityScore: 0.91,
      },
      // 82002 carries no row and sorts between the two. (Not "the ~99% case" an
      // earlier version of this comment claimed — that is the corpus-wide rate, and
      // coverage inside a popularity-ordered top-100 measured 33-45%.)
      {
        modelVersionId: 83003,
        role: 'style',
        styleFamily: 'anime_manga',
        confidence: 0.55,
        qualityScore: 0.29,
      },
    ]);

    const result = await getResourceIntent(INPUT, CTX);

    expect(result.degraded).toBe(false);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([83003, 82002, 81001]);
    // And the order reached hydration, not just the response projection.
    expect(mockGetResourceData.mock.calls[0][0]).toEqual([83003, 82002, 81001]);
  });

  // Green at `origin/main` too, so an invariant guard by the red/green matrix — and
  // still load-bearing: the ordering test above expects the exact reverse of the
  // seed, so a mutant that ignores the labels and reverses the tiebreak passes it.
  // This is what fails. It covers BOTH tiebreaks, because the flat stage-3
  // distribution leaves `combineStage3Answers` ordering on index too.
  it('with no labels at all the response keeps the seed order — kills a reversed tiebreak', async () => {
    const result = await getResourceIntent(INPUT, CTX);

    expect(result.degraded).toBe(false);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([81001, 82002, 83003]);
  });

  it('🔴 compiles the style family the ordering reads into the versioned criteria', async () => {
    const result = await getResourceIntent(INPUT, CTX);

    expect(result.criteria).toMatchObject({ role: 'style', styleFamily: 'anime_manga' });
  });

  // 🔴 SINGLE-AXIS agreement, both ways round, because every other fixture in this
  // segment agrees on BOTH axes — which satisfies both branches and so selects
  // neither. Measured: with both-axis fixtures only, corrupting the `want` on either
  // axis (`styleFamily: 'other'`, or `role: 'none'`) survived all fourteen
  // integration assertions. These two arms are what make the compiled criteria a
  // GUARD rather than a field that merely exists: each promotes on one axis alone, so
  // losing that axis does not just lower the row, it DEMOTES it — the recognised role
  // then reads as a disagreement — sending it last instead of first.
  it('🔴 a label agreeing on the STYLE axis alone still leads the response', async () => {
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      {
        modelVersionId: 83003,
        role: 'character',
        styleFamily: 'anime_manga',
        confidence: 0.55,
        qualityScore: 0.24,
      },
    ]);

    const result = await getResourceIntent(INPUT, CTX);

    expect(result.suggestions.map((s) => s.versionId)).toEqual([83003, 81001, 82002]);
  });

  // 🔴 THE SEAM TEST for the label-read fallback, and the reason it belongs in this
  // suite rather than either single-module one: the defect was that the matcher's
  // fail-soft path returned a correctly-shaped, correctly-capped shortlist and told
  // the caller nothing, so the service — which owns the cache TTL — could not tell
  // an UNORDERED response from an ordered one. Both suites were green throughout:
  // the matcher suite never runs the service, and the service suite mocks the
  // matcher, so the only thing either could have checked is the mock.
  //
  // Red before the fix with `EX: 3600` — an unordered, popularity-only response
  // pinned to this cache key for an hour, where the analogous VENDOR failure is
  // cached for 60s with the comment three lines above explaining why.
  it('🔴 an unreachable label table serves the seed order and caches it for 60s, not an hour', async () => {
    dbMock.dbRead.resourceInsight.findMany.mockRejectedValue(new Error('relation missing'));

    const result = await getResourceIntent(INPUT, CTX);

    expect(redisMock.redis.packed.set).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    // What was served is the seed order, with no per-version label ordering — which
    // is exactly why the hour was wrong.
    expect(result.suggestions.map((s) => s.versionId)).toEqual([81001, 82002, 83003]);
    // And not a degrade: a real intent, real suggestions, the vendor's own model.
    expect(result.degraded).toBe(false);
    expect(result.insightFallback).toBe(true);
    expect(result.intent).not.toBeNull();
    expect(result.model).toBe('typesafe/jev-1.13-20260917');
    // The flag is in the CACHED blob, so a replay reports it too.
    expect(redisMock.redis.packed.set.mock.calls[0][1]).toMatchObject({ insightFallback: true });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-insight-read-failed' }),
      'temp-search'
    );
  });

  // 🔴 The control arm the test above needs, and it is NOT the no-labels test higher
  // up: that one asserts an order, never a TTL. A healthy label read that happens to
  // return NOTHING must keep the full hour — otherwise `EX: 60` unconditionally, or
  // "no usable label ⇒ fallback", passes the test above while cutting the TTL on the
  // commonest response the endpoint produces.
  it('🔴 a healthy label read that returns no rows keeps the 1h TTL', async () => {
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);

    const result = await getResourceIntent(INPUT, CTX);

    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 3600 });
    expect(result.insightFallback).toBe(false);
    expect(result.suggestions.map((s) => s.versionId)).toEqual([81001, 82002, 83003]);
  });

  it('🔴 a label agreeing on the ROLE axis alone still leads the response', async () => {
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      {
        modelVersionId: 83003,
        role: 'style',
        styleFamily: 'pixel_retro',
        confidence: 0.55,
        qualityScore: 0.24,
      },
    ]);

    const result = await getResourceIntent(INPUT, CTX);

    expect(result.suggestions.map((s) => s.versionId)).toEqual([83003, 81001, 82002]);
  });
});
