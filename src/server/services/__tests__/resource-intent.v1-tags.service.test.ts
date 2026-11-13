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
import type * as TagsHolder from '~/server/services/resource-intent-tags/holder';
import type { TagIndex, TagIndexKind } from '~/server/services/resource-intent-tags/score';

/**
 * The v1_tags arm of the resource-intent service: the served arm and its failure ladder, its cache
 * key, the optional response fields, the shadow computation beside other arms, and the judge-capture
 * writer. Jev, both snapshot holders, the matcher's two list functions, hydration, redis and
 * ClickHouse are mocked at their seams; the scorer runs for real over a synthetic index.
 */

const mockAskJev = vi.fn();
const mockPoolMerge = vi.fn();
const mockV1Candidates = vi.fn();
const mockCheckpointCandidates = vi.fn();
const mockGetResourceData = vi.fn();
const mockInsert = vi.fn();
const mockCoocResolve = vi.fn();
const mockTagResolve = vi.fn();
const clickhouseState = { present: true };

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-matcher.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MatcherModule>()),
  findPoolMergeCandidates: (...args: unknown[]) => mockPoolMerge(...(args as [])),
  findRankedCandidates: (...args: unknown[]) => mockV1Candidates(...(args as [])),
  findCheckpointCandidates: (...args: unknown[]) => mockCheckpointCandidates(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-cooc/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof CoocHolder>()),
  coocSnapshotHolder: () => ({ resolve: mockCoocResolve }),
  coocStudySnapshots: () => ({
    get: async () => ({ contentHash: 'b'.repeat(64), scores: SCORES }),
  }),
}));
vi.mock('~/server/services/resource-intent-tags/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof TagsHolder>()),
  tagIndexSnapshotHolder: () => ({ resolve: mockTagResolve }),
}));
// Hand-listed for the reason resource-intent.service.test.ts records.
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return clickhouseState.present ? { insert: mockInsert } : undefined;
  },
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const {
  getResourceIntent,
  resourceIntentCacheKey,
  v1TagsCacheKey,
  COOC_FALLBACK_SNAPSHOT_KEY,
  JUDGE_SAMPLE_TABLE,
} = await import('~/server/services/resource-intent.service');
const { RESOURCE_INTENT_SPEC_HASH, resourceIntentResponseSchema } = await import(
  '~/server/schema/resource-intent.schema'
);
const { RESOURCE_INTENT_TAGS_SPEC_HASH } = await import(
  '~/server/services/resource-intent-tags/spec'
);
const { RESOURCE_INTENT_COOC_SPEC } = await import('~/server/services/resource-intent-cooc/spec');
const { RESOURCE_INTENT_V1_GATE_SPEC_HASH, V1_TAGS_MIN_ECOSYSTEM_RESOURCES } = await import(
  '~/server/services/resource-intent-tags/gate'
);
const { CoocCountAccumulator } = await import('~/server/services/resource-intent-cooc/build');
const { loadScores } = await import('~/server/services/resource-intent-cooc/score');

/** A real co-occurrence snapshot's scores, so a fallback's ranking runs. */
const SCORES = (() => {
  const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  for (let i = 0; i < 5; i++) acc.add(['nothing'], [[707, 'LORA']]);
  for (let i = 0; i < 195; i++) acc.add([], []);
  const {
    rawPairs: _p,
    rawVocab: _v,
    typeConflicts: _t,
    ...counts
  } = acc.finalize(RESOURCE_INTENT_COOC_SPEC);
  return loadScores(counts, { beta: RESOURCE_INTENT_COOC_SPEC.beta });
})();

const PROMPT = 'zephyr, lantern, portrait';
// Not the audience the coverage mock answers, so a test can tell the request's coverage from a lookup.
const CTX = { browsingLevel: 3, coverage: { next: true, member: false } };
const SNAPSHOT_SHA = 'c'.repeat(64);
const VOCAB = 'd'.repeat(64);

/**
 * Three tags: `zephyr` (SDXL-leaning, two add-ons), `velvet` (explicit, one Illustrious add-on) and
 * `lantern` (Illustrious-leaning, the same add-on). Model ids are distinct from version ids. Untagged
 * add-ons published for both ecosystems fill each one's pool past the floor a tag-chosen ecosystem
 * needs, so they rank nothing but keep both ecosystems choosable.
 */
const CATALOGUE_FILL = V1_TAGS_MIN_ECOSYSTEM_RESOURCES;
function tagIndex(ecosystemUsers = [200, 150]): TagIndex {
  const vocabulary = [
    { key: 'zephyr', idf: 2, near: [], explicit: false },
    { key: 'velvet', idf: 1.5, near: [], explicit: true },
    { key: 'lantern', idf: 1, near: [], explicit: false },
  ];
  const kind = (modelIds: number[], ecosystems: number[][], ptr: number[], resource: number[]) =>
    ({
      modelIds,
      fit: new Float64Array(modelIds.length),
      ecosystems,
      postings: {
        ptr: Uint32Array.from(ptr),
        resource: Uint32Array.from(resource),
        c: Float64Array.from(resource.map((_, i) => 0.9 - i * 0.1)),
        fit: Float64Array.from(resource.map(() => NaN)),
      },
      ecosystemUsers: new Map(),
      userByTag: new Map(),
      userByEcosystem: new Map(),
    } satisfies TagIndexKind);
  return {
    vocabulary,
    idByKey: new Map(vocabulary.map((t, i) => [t.key, i])),
    ecosystems: [
      { name: 'SDXL 1.0', users: ecosystemUsers[0], observations: 100 },
      { name: 'Illustrious', users: ecosystemUsers[1], observations: 80 },
    ],
    tagEcosystemCounts: new Map([
      [0, new Map([[0, 30]])],
      [1, new Map([[1, 50]])],
      [2, new Map([[1, 10]])],
    ]),
    kinds: {
      addon: kind(
        [101, 102, 103, ...Array.from({ length: CATALOGUE_FILL }, (_, i) => 1000 + i)],
        [[0], [0], [1], ...Array.from({ length: CATALOGUE_FILL }, () => [0, 1])],
        [0, 2, 3, 4],
        [0, 1, 2, 2]
      ),
      checkpoint: kind([201], [[0]], [0, 1, 1, 1], [0]),
    },
  };
}

const held = (index = tagIndex()) => ({
  snapshot: {
    id: '7',
    payloadSha256: SNAPSHOT_SHA,
    specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
    vocabVersion: VOCAB,
    createdAt: new Date('2026-10-13T06:00:00Z'),
    index,
  },
  fallbackReason: null,
});
const tagFallback = (reason: string) => ({ snapshot: null, fallbackReason: reason });

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

/** v1's own list (versions 31, 32) and the POOL_MERGE list (21, 22) are disjoint, so a test can tell them apart. */
const V1_IDS = [31, 32];
const POOL_IDS = [21, 22];

const keyOf = (terms: string[]) =>
  `packed:caches:jev-resource-intent:v1:${createHash('sha256')
    .update(terms.join('|'))
    .digest('hex')}`;

type Insert = { table: string; values: Record<string, unknown>[] };
const inserts = (table: string) =>
  mockInsert.mock.calls.map((c) => c[0] as Insert).filter((c) => c.table === table);
const shadowRow = () => inserts('resourceIntentShadow')[0].values[0];
const flush = () => vi.waitFor(() => expect(inserts('resourceIntentShadow')).toHaveLength(1));

beforeEach(() => {
  clickhouseState.present = true;
  mockAskJev.mockReset();
  mockPoolMerge.mockReset();
  mockPoolMerge.mockResolvedValue({ entries: [entry(21, 2), entry(22, 3)], coocGated: 1 });
  mockV1Candidates.mockReset();
  mockV1Candidates.mockResolvedValue([entry(31, 101), entry(32, 102)]);
  mockCheckpointCandidates.mockReset();
  mockCheckpointCandidates.mockResolvedValue([entry(41, 201)]);
  mockGetResourceData.mockReset();
  mockGetResourceData.mockImplementation(async (ids: number[]) => ids.map(genResource));
  mockInsert.mockReset();
  mockInsert.mockResolvedValue(undefined);
  mockCoocResolve.mockReset();
  mockCoocResolve.mockResolvedValue({ snapshot: null, fallbackReason: 'no_snapshot' });
  mockTagResolve.mockReset();
  mockTagResolve.mockResolvedValue(held());
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
});

const V1 = { ...CTX, v1: true };
const ids = (r: { suggestions: { versionId: number }[] }) => r.suggestions.map((s) => s.versionId);

describe('cache key', () => {
  const base = { prompt: 'p', baseModel: 'SDXL 1.0', browsingLevel: 3, cap: 50 };

  it('🔴 carries the arm, the request, the snapshot, the tags spec, the gate spec and the stage-1 spec, in order', () => {
    expect(v1TagsCacheKey({ ...base, snapshot: SNAPSHOT_SHA, tagsSpecHash: 'e'.repeat(64) })).toBe(
      keyOf([
        'v1_tags',
        'p',
        'SDXL 1.0',
        '3',
        '50',
        'addon',
        SNAPSHOT_SHA,
        'e'.repeat(64),
        RESOURCE_INTENT_V1_GATE_SPEC_HASH,
        RESOURCE_INTENT_SPEC_HASH,
      ])
    );
  });

  it('is disjoint from the HYBRID_10 and POOL_MERGE keys for the same request', () => {
    const v1 = v1TagsCacheKey({ ...base, snapshot: SNAPSHOT_SHA, tagsSpecHash: 'e' });
    expect(v1).not.toBe(resourceIntentCacheKey(base));
    expect(v1).not.toBe(resourceIntentCacheKey({ ...base, poolMerge: { snapshot: SNAPSHOT_SHA } }));
  });

  it("the service keys on the held snapshot's hash and the code's tags spec hash", async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, V1);
    const expected = v1TagsCacheKey({
      prompt: PROMPT,
      baseModel: 'SDXL 1.0',
      browsingLevel: 3,
      cap: 50,
      snapshot: SNAPSHOT_SHA,
      tagsSpecHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
    });
    expect(redisMock.redis.packed.get).toHaveBeenCalledWith(expected);
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(expected);
  });

  it('with no snapshot held, the key names the fallback and no tags spec', async () => {
    mockTagResolve.mockResolvedValue(tagFallback('no_snapshot'));
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, V1);
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
      v1TagsCacheKey({
        prompt: PROMPT,
        browsingLevel: 3,
        cap: 50,
        snapshot: COOC_FALLBACK_SNAPSHOT_KEY,
        tagsSpecHash: '',
      })
    );
  });
});

describe('🔴 the response schema seam (cached blobs across a rolling deploy)', () => {
  const OLD_POOL_MERGE_BLOB = {
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

  it('a POOL_MERGE blob written before this arm existed still parses', () => {
    expect(resourceIntentResponseSchema.safeParse(OLD_POOL_MERGE_BLOB).success).toBe(true);
  });

  it("a v1 response parses, and its new keys are absent from every other arm's response", async () => {
    mockStage1();
    const v1 = await getResourceIntent({ prompt: PROMPT }, V1);
    expect(resourceIntentResponseSchema.safeParse(v1).success).toBe(true);
    mockStage1();
    const pool = await getResourceIntent({ prompt: PROMPT }, { ...CTX, poolMerge: true });
    const v1Only = Object.keys(v1).filter((k) => !(k in pool));
    expect(v1Only.sort()).toEqual(['arm', 'ecosystems', 'v1Fallback']);
  });
});

describe('served v1_tags', () => {
  it("serves v1's own list behind the gates, with stage 1's intent and an hour's cache", async () => {
    mockStage1();
    const result = await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, V1);
    expect(mockAskJev).toHaveBeenCalledTimes(1);
    expect(mockPoolMerge).not.toHaveBeenCalled();
    expect(mockCoocResolve).not.toHaveBeenCalled();
    expect(mockV1Candidates).toHaveBeenCalledTimes(1);
    expect(mockV1Candidates.mock.calls[0][0]).toMatchObject({
      modelIds: [101, 102],
      modelTypes: RESOURCE_INTENT_COOC_SPEC.addonTypes,
      browsingLevel: 3,
      coverage: CTX.coverage,
      cap: 50,
      maxModels: 50,
    });
    const { baseModel } = mockV1Candidates.mock.calls[0][0] as { baseModel: Map<string, string[]> };
    expect(baseModel.get('LORA')).toEqual(expect.arrayContaining(['SDXL 1.0', 'SDXL Lightning']));
    expect(result).toMatchObject({ degraded: false, arm: 'v1_tags', v1Fallback: false });
    expect(result).not.toHaveProperty('coocFallback');
    expect(result).not.toHaveProperty('ecosystems');
    expect(result.intent?.role.value).toBe('style');
    expect(result.criteria).not.toBeNull();
    expect(result.noneProbability).toBe(0.1);
    expect(ids(result)).toEqual(V1_IDS);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 3600 });
  });

  it('without a baseModel: the tag-derived ecosystem gates the list and the top ecosystems are returned', async () => {
    mockStage1();
    const result = await getResourceIntent({ prompt: 'zephyr' }, V1);
    const { baseModel } = mockV1Candidates.mock.calls[0][0] as { baseModel: Map<string, string[]> };
    expect(baseModel.get('LORA')).toEqual(expect.arrayContaining(['SDXL 1.0', 'SDXL Lightning']));
    expect(result.ecosystems).toEqual(['SDXL 1.0', 'Illustrious']);
  });

  it("the caller's limit reaches the gate, and the key", async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0', limit: 7 }, V1);
    expect(mockV1Candidates.mock.calls[0][0]).toMatchObject({ cap: 7 });
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
      v1TagsCacheKey({
        prompt: PROMPT,
        baseModel: 'SDXL 1.0',
        browsingLevel: 3,
        cap: 7,
        snapshot: SNAPSHOT_SHA,
        tagsSpecHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
      })
    );
  });

  it('a stage-1 role of none does not empty the list (role-free)', async () => {
    mockAskJev.mockImplementationOnce(async () => ({
      answers: STAGE1_ANSWERS.map((a) =>
        a.id === 'role' ? { ...a, value: 'none', distribution: { none: 0.9, style: 0.1 } } : a
      ),
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'typesafe/jev-1.13-20260917',
    }));
    const result = await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, V1);
    expect(ids(result)).toEqual(V1_IDS);
    expect(result.noneProbability).toBe(0.9);
  });

  it('overrides poolMerge, and is not used in study mode', async () => {
    mockStage1();
    const both = await getResourceIntent({ prompt: PROMPT }, { ...V1, poolMerge: true });
    expect(both.arm).toBe('v1_tags');
    mockStage1();
    const study = await getResourceIntent(
      { prompt: PROMPT },
      { ...V1, coocSnapshotId: 'b'.repeat(64) }
    );
    expect(study.arm).toBeUndefined();
  });

  it('the row records the arm, the snapshot, the tags it read and the ecosystem source', async () => {
    mockStage1();
    await getResourceIntent({ prompt: 'zephyr, velvet' }, { ...V1, browsingLevel: 31 });
    await flush();
    expect(shadowRow()).toMatchObject({
      arm: 'v1_tags',
      v1Fallback: 0,
      v1FallbackReason: '',
      coocSpecHash: '',
      poolMergeSpecHash: '',
      tagSnapshotHash: SNAPSHOT_SHA,
      vocabVersion: VOCAB,
      tagsSpecHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
      literalTagCount: 2,
      explicitTagsRemoved: 0,
      ecosystemSource: 'tags',
      suggestionIds: V1_IDS,
    });
    expect(shadowRow()).not.toHaveProperty('shadowArm');
  });
});

describe('🔴 the failure ladder: each rung serves the POOL_MERGE list, flagged, for 60 s', () => {
  async function expectFallback(
    input: { prompt: string; baseModel?: string },
    ctx: typeof V1,
    reason: string
  ) {
    mockStage1();
    const result = await getResourceIntent(input, ctx);
    expect(result).toMatchObject({
      degraded: false,
      arm: 'v1_tags',
      v1Fallback: true,
      coocFallback: true,
    });
    expect(result).not.toHaveProperty('ecosystems');
    expect(ids(result)).toEqual(POOL_IDS);
    expect(result.intent).not.toBeNull();
    expect(mockPoolMerge).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    await flush();
    expect(shadowRow()).toMatchObject({ arm: 'v1_tags', v1Fallback: 1, v1FallbackReason: reason });
  }

  it.each(['disabled', 'no_snapshot', 'loading', 'load_failed', 'snapshot_unservable'])(
    'no servable tag index (%s)',
    async (reason) => {
      mockTagResolve.mockResolvedValue(tagFallback(reason));
      await expectFallback({ prompt: PROMPT }, V1, reason);
      expect(mockV1Candidates).not.toHaveBeenCalled();
    }
  );

  it('no vocabulary tag in the prompt (no_tags)', async () => {
    await expectFallback({ prompt: 'an unrelated prompt' }, V1, 'no_tags');
    expect(mockV1Candidates).not.toHaveBeenCalled();
  });

  it('a role-none prompt on a fallback rung gets the POOL_MERGE answer: an empty list', async () => {
    mockAskJev.mockImplementationOnce(async () => ({
      answers: STAGE1_ANSWERS.map((a) =>
        a.id === 'role' ? { ...a, value: 'none', distribution: { none: 0.9, style: 0.1 } } : a
      ),
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'typesafe/jev-1.13-20260917',
    }));
    const result = await getResourceIntent({ prompt: 'nothing' }, V1);
    expect(result).toMatchObject({ degraded: false, v1Fallback: true, suggestions: [] });
    expect(mockPoolMerge).not.toHaveBeenCalled();
    await flush();
    expect(shadowRow()).toMatchObject({ v1FallbackReason: 'no_tags', shortlistCount: 0 });
  });

  it('the row counts the literal tags found, not those kept, and how many the gate removed', async () => {
    mockStage1();
    await getResourceIntent({ prompt: 'zephyr, velvet', baseModel: 'SDXL 1.0' }, V1);
    await flush();
    expect(shadowRow()).toMatchObject({ literalTagCount: 2, explicitTagsRemoved: 1 });
  });

  it('D3: every tag explicit at an SFW level (no_tags), though the same prompt ranks at a mature level', async () => {
    await expectFallback({ prompt: 'velvet' }, V1, 'no_tags');
    mockInsert.mockClear();
    redisMock.redis.packed.set.mockClear();
    mockStage1();
    const mature = await getResourceIntent({ prompt: 'velvet' }, { ...V1, browsingLevel: 31 });
    expect(mature.v1Fallback).toBe(false);
  });

  it('no ecosystem has enough training users and none was given (no_ecosystem)', async () => {
    mockTagResolve.mockResolvedValue(held(tagIndex([10, 10])));
    await expectFallback({ prompt: PROMPT }, V1, 'no_ecosystem');
  });

  it("the caller's baseModel is not in the index (unknown_ecosystem)", async () => {
    await expectFallback({ prompt: PROMPT, baseModel: 'Pony' }, V1, 'unknown_ecosystem');
    expect(mockV1Candidates).not.toHaveBeenCalled();
  });

  it('nothing ranked survives the gates (no_candidates)', async () => {
    mockV1Candidates.mockResolvedValue([]);
    await expectFallback({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, V1, 'no_candidates');
  });

  it('nothing survives hydration (no_candidates)', async () => {
    mockGetResourceData.mockImplementation(async (vs: number[]) =>
      vs.map((id) => ({ ...genResource(id), hasAccess: !V1_IDS.includes(id) }))
    );
    await expectFallback({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, V1, 'no_candidates');
  });

  it("the fallback's POOL_MERGE list uses a held co-occurrence snapshot", async () => {
    mockTagResolve.mockResolvedValue(tagFallback('no_snapshot'));
    mockCoocResolve.mockResolvedValue({
      snapshot: { contentHash: 'a'.repeat(64), scores: SCORES },
      fallbackReason: null,
    });
    mockStage1();
    const result = await getResourceIntent({ prompt: 'nothing' }, V1);
    expect(result).toMatchObject({ v1Fallback: true, coocFallback: false });
    expect(mockPoolMerge.mock.calls[0][1]).toMatchObject({ coocCandidates: [707] });
    // No coocFallback here, so only the v1 fallback's own rung can make this 60 s.
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    await flush();
    expect(shadowRow()).toMatchObject({ coocSnapshotHash: 'a'.repeat(64), coocFallback: 0 });
  });

  it('a gate failure degrades as today', async () => {
    mockStage1();
    mockV1Candidates.mockRejectedValue(new Error('search down'));
    const result = await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, V1);
    expect(result).toMatchObject({
      degraded: true,
      arm: 'v1_tags',
      v1Fallback: false,
      intent: null,
      criteria: null,
      suggestions: [],
    });
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    expect(mockPoolMerge).not.toHaveBeenCalled();
  });

  it('a hydration failure degrades as today', async () => {
    mockStage1();
    mockGetResourceData.mockRejectedValue(new Error('db down'));
    const result = await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, V1);
    expect(result).toMatchObject({ degraded: true, suggestions: [], intent: null });
  });

  it('a stage-1 failure degrades as today, with the fallback flag it had', async () => {
    mockTagResolve.mockResolvedValue(tagFallback('loading'));
    mockAskJev.mockRejectedValue(new Error('timeout'));
    const result = await getResourceIntent({ prompt: PROMPT }, V1);
    expect(result).toMatchObject({ degraded: true, arm: 'v1_tags', v1Fallback: true });
    await flush();
    expect(shadowRow()).toMatchObject({ degraded: 1, v1Fallback: 1, v1FallbackReason: 'loading' });
  });
});

describe('served v1_tags cache hit', () => {
  it('a cached fallback replays with no vendor call and names itself on the row', async () => {
    const cached = {
      degraded: false,
      insightFallback: false,
      arm: 'v1_tags',
      v1Fallback: true,
      coocFallback: true,
      intent: null,
      criteria: null,
      suggestions: [{ versionId: 21 }],
      noneProbability: null,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2,
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);
    const result = await getResourceIntent({ prompt: PROMPT }, V1);
    expect(result).toEqual(cached);
    expect(mockAskJev).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    await flush();
    expect(shadowRow()).toMatchObject({
      v1Fallback: 1,
      v1FallbackReason: 'cached_fallback',
      literalTagCount: 0,
      tagSnapshotHash: SNAPSHOT_SHA,
    });
  });
});

/**
 * `tagIndex()` with ecosystem 1 renamed to a real base model whose add-on gate holds a sibling. Krea 2
 * Turbo's ecosystem has two records, Krea 2 and Krea 2 Turbo, and generates checkpoints and LoRAs but
 * no embeddings: so its LORA and Checkpoint gates are both names, its TextualInversion gate its own.
 */
function kreaIndex(): TagIndex {
  const index = tagIndex();
  index.ecosystems[1] = { ...index.ecosystems[1], name: 'Krea 2 Turbo' };
  return index;
}

describe('🔴 the base-model filter of the v1 list, by kind and by who chose the ecosystem', () => {
  beforeEach(() => mockTagResolve.mockResolvedValue(held(kreaIndex())));
  const filterOf = (call = 0) =>
    (mockV1Candidates.mock.calls[call][0] as { baseModel: unknown }).baseModel;

  it("an add-on request's caller baseModel gates by its compatible base models, not its exact name", async () => {
    mockStage1();
    const result = await getResourceIntent({ prompt: PROMPT, baseModel: 'Krea 2 Turbo' }, V1);
    expect(result).toMatchObject({ arm: 'v1_tags', v1Fallback: false });
    expect(mockV1Candidates).toHaveBeenCalledTimes(1);
    const filter = filterOf();
    expect(filter).toBeInstanceOf(Map);
    const byType = filter as Map<string, string[]>;
    expect([...(byType.get('LORA') ?? [])].sort()).toEqual(['Krea 2', 'Krea 2 Turbo']);
    expect(byType.get('TextualInversion')).toEqual(['Krea 2 Turbo']);
  });

  it('a checkpoint request with a caller baseModel still lists that exact name', async () => {
    const input = { prompt: 'zephyr', baseModel: 'Krea 2 Turbo', kind: 'checkpoint' as const };
    await getResourceIntent(input, { ...CTX, v1Shadow: true });
    await flush();
    expect(shadowRow()).toMatchObject({
      kind: 'checkpoint',
      shadowArm: 'v1_tags',
      shadowReason: '',
    });
    expect(mockV1Candidates.mock.calls[0][0]).toMatchObject({ modelTypes: ['Checkpoint'] });
    expect(filterOf()).toBe('Krea 2 Turbo');
  });

  it('a tag-chosen add-on ecosystem gates by the same compatible base models (unchanged)', async () => {
    mockStage1();
    const result = await getResourceIntent({ prompt: 'lantern' }, V1);
    expect(result.ecosystems?.[0]).toBe('Krea 2 Turbo');
    const byType = filterOf() as Map<string, string[]>;
    expect([...(byType.get('LORA') ?? [])].sort()).toEqual(['Krea 2', 'Krea 2 Turbo']);
    expect(byType.get('TextualInversion')).toEqual(['Krea 2 Turbo']);
  });
});

describe('🔴 the shadow beside another arm', () => {
  const SHADOW = { ...CTX, poolMerge: true, v1Shadow: true };

  it("gates as the served arm does: the tag-chosen ecosystem and a caller's add-on baseModel by its gate", async () => {
    mockStage1();
    await getResourceIntent({ prompt: 'zephyr' }, SHADOW);
    await flush();
    const tagChosen = mockV1Candidates.mock.calls[0][0] as { baseModel: Map<string, string[]> };
    expect(tagChosen.baseModel.get('LORA')).toEqual(expect.arrayContaining(['SDXL Lightning']));
    expect(shadowRow()).toMatchObject({ shadowSuggestionIds: V1_IDS, ecosystemSource: 'tags' });

    mockInsert.mockClear();
    mockStage1();
    await getResourceIntent({ prompt: 'zephyr', baseModel: 'SDXL 1.0' }, SHADOW);
    await flush();
    const caller = mockV1Candidates.mock.calls[1][0] as { baseModel: Map<string, string[]> };
    expect(caller.baseModel.get('LORA')).toEqual(expect.arrayContaining(['SDXL Lightning']));
  });

  it('records the v1 list it would have served, and serves the POOL_MERGE list unchanged', async () => {
    mockStage1();
    const off = await getResourceIntent(
      { prompt: PROMPT, baseModel: 'SDXL 1.0' },
      {
        ...CTX,
        poolMerge: true,
      }
    );
    await flush();
    expect(Object.keys(shadowRow()).filter((k) => k.startsWith('shadow'))).toEqual([]);
    expect(mockTagResolve).not.toHaveBeenCalled();

    mockInsert.mockClear();
    mockStage1();
    const on = await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
    expect(on).toEqual(off);
    await flush();
    expect(shadowRow()).toMatchObject({
      arm: 'pool_merge',
      suggestionIds: POOL_IDS,
      shadowArm: 'v1_tags',
      shadowDegraded: 0,
      shadowReason: '',
      shadowSuggestionIds: V1_IDS,
      tagSnapshotHash: SNAPSHOT_SHA,
      literalTagCount: 2,
      ecosystemSource: 'caller',
    });
    expect(mockAskJev).toHaveBeenCalledTimes(2);
  });

  it('runs on a cache hit of the served arm too', async () => {
    redisMock.redis.packed.get.mockResolvedValue({
      degraded: false,
      insightFallback: false,
      coocFallback: false,
      intent: null,
      criteria: null,
      suggestions: [{ versionId: 21 }],
      noneProbability: null,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2,
    });
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
    await flush();
    expect(shadowRow()).toMatchObject({ shadowArm: 'v1_tags', shadowSuggestionIds: V1_IDS });
  });

  it("records a fallback rung's reason without a list", async () => {
    mockTagResolve.mockResolvedValue(tagFallback('load_failed'));
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, SHADOW);
    await flush();
    expect(shadowRow()).toMatchObject({
      shadowArm: 'v1_tags',
      shadowDegraded: 0,
      shadowReason: 'load_failed',
      shadowSuggestionIds: [],
    });
  });

  it.each([
    ['the holder throws', () => mockTagResolve.mockRejectedValue(new Error('boom'))],
    ['the gate throws', () => mockV1Candidates.mockRejectedValue(new Error('search down'))],
  ])(
    '🔴 %s: the served response is unchanged and the row says shadowDegraded',
    async (_, arrange) => {
      mockStage1();
      const off = await getResourceIntent(
        { prompt: PROMPT, baseModel: 'SDXL 1.0' },
        {
          ...CTX,
          poolMerge: true,
        }
      );
      await flush();
      mockInsert.mockClear();
      arrange();
      mockStage1();
      const on = await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
      expect(on).toEqual(off);
      await flush();
      expect(shadowRow()).toMatchObject({
        arm: 'pool_merge',
        suggestionIds: POOL_IDS,
        shadowDegraded: 1,
        shadowReason: 'error',
      });
    }
  );

  it('🔴 adds no awaited latency: the response returns before the shadow starts, and while it has not settled', async () => {
    let release!: (v: unknown) => void;
    mockTagResolve.mockReturnValue(new Promise((r) => (release = r)));
    mockStage1();
    try {
      const result = await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
      expect(ids(result)).toEqual(POOL_IDS);
      expect(mockTagResolve).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mockTagResolve).toHaveBeenCalledTimes(1));
      // Its row waits on the shadow.
      expect(inserts('resourceIntentShadow')).toHaveLength(0);
    } finally {
      release?.(tagFallback('loading'));
    }
    await flush();
  });

  it.each([
    ['settle', (r: { res: (v: unknown) => void }) => r.res(tagFallback('loading'))],
    ['throw', (r: { rej: (e: unknown) => void }) => r.rej(new Error('boom'))],
  ] as const)(
    'past the per-pod limit a shadow is skipped, not queued, and running ones that %s give their slot back',
    async (_, finish) => {
      const pending: { res: (v: unknown) => void; rej: (e: unknown) => void }[] = [];
      mockTagResolve.mockImplementation(
        () => new Promise((res, rej) => pending.push({ res, rej }))
      );
      try {
        for (let i = 0; i < 4; i++) {
          mockStage1();
          await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
        }
        await vi.waitFor(() => expect(mockTagResolve).toHaveBeenCalledTimes(4));
        mockStage1();
        await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
        await flush();
        expect(shadowRow()).toMatchObject({ shadowArm: 'v1_tags', shadowReason: 'skipped' });
        expect(mockTagResolve).toHaveBeenCalledTimes(4);
      } finally {
        for (const p of pending) finish(p as never);
      }
      await vi.waitFor(() => expect(inserts('resourceIntentShadow')).toHaveLength(5));
      mockInsert.mockClear();
      mockTagResolve.mockResolvedValue(held());
      mockStage1();
      await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
      await flush();
      expect(shadowRow()).toMatchObject({ shadowReason: '', shadowSuggestionIds: V1_IDS });
    }
  );

  it("without the caller's coverage (as the route calls it), a shadow on a cache hit looks the audience up", async () => {
    const { coverageAudience } = await import('~/server/services/generation/coverage-source');
    vi.mocked(coverageAudience).mockClear();
    redisMock.redis.packed.get.mockResolvedValue({
      degraded: false,
      insightFallback: false,
      coocFallback: false,
      intent: null,
      criteria: null,
      suggestions: [{ versionId: 21 }],
      noneProbability: null,
      model: 'typesafe/jev-1.13-20260917',
      criteriaVersion: 2,
    });
    const { coverage: _c, ...noCoverage } = SHADOW;
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, noCoverage);
    await flush();
    expect(coverageAudience).toHaveBeenCalledTimes(1);
    expect(mockV1Candidates.mock.calls[0][0]).toMatchObject({
      coverage: { next: false, member: false },
    });
  });

  it('beside HYBRID_10 too', async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, { ...CTX, v1Shadow: true });
    await flush();
    expect(shadowRow()).not.toHaveProperty('arm');
    expect(shadowRow()).toMatchObject({ shadowArm: 'v1_tags', shadowSuggestionIds: V1_IDS });
  });

  it("passes the request's limit and coverage to the gate", async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0', limit: 7 }, SHADOW);
    await flush();
    expect(mockV1Candidates.mock.calls[0][0]).toMatchObject({ cap: 7, coverage: CTX.coverage });
  });

  it("the row's latencyMs is the served response's, not the shadow's", async () => {
    mockTagResolve.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(held()), 120))
    );
    mockStage1();
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, SHADOW);
    await flush();
    expect(shadowRow().shadowLatencyMs).toBeGreaterThanOrEqual(100);
    expect(shadowRow().latencyMs as number).toBeLessThan(shadowRow().shadowLatencyMs as number);
  });

  it('is not computed on a served v1 row', async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, { ...V1, v1Shadow: true });
    await flush();
    expect(mockTagResolve).toHaveBeenCalledTimes(1);
    expect(shadowRow()).not.toHaveProperty('shadowArm');
  });

  it('D4: on a checkpoint row, ranks checkpoints for its baseModel and serves ATTACH_BM unchanged', async () => {
    mockCoocResolve.mockResolvedValue({ snapshot: null, fallbackReason: 'no_snapshot' });
    const input = { prompt: 'zephyr', baseModel: 'SDXL 1.0', kind: 'checkpoint' as const };
    const off = await getResourceIntent(input, CTX);
    await flush();
    mockInsert.mockClear();
    mockV1Candidates.mockResolvedValue([entry(51, 201)]);
    const on = await getResourceIntent(input, { ...CTX, v1Shadow: true });
    expect(on).toEqual(off);
    expect(mockAskJev).not.toHaveBeenCalled();
    await flush();
    expect(mockV1Candidates.mock.calls[0][0]).toMatchObject({
      modelIds: [201],
      modelTypes: ['Checkpoint'],
      baseModel: 'SDXL 1.0',
    });
    expect(shadowRow()).toMatchObject({
      kind: 'checkpoint',
      arm: 'attach_bm',
      suggestionIds: [41],
      shadowArm: 'v1_tags',
      shadowSuggestionIds: [51],
    });
  });
});

describe('🔴 judge capture', () => {
  it('flag off: no row is written to the capture table', async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, { ...CTX, poolMerge: true });
    await flush();
    await new Promise((r) => setImmediate(r));
    expect(inserts(JUDGE_SAMPLE_TABLE)).toHaveLength(0);
  });

  it('flag on: one row of exactly the prompt, its hash, the time, the level and the baseModel', async () => {
    mockStage1();
    const ctx = {
      ...CTX,
      poolMerge: true,
      judgeCapture: true,
      now: () => new Date('2026-10-17T01:02:03.456Z'),
    };
    await getResourceIntent({ prompt: PROMPT, baseModel: 'SDXL 1.0' }, ctx);
    await vi.waitFor(() => expect(inserts(JUDGE_SAMPLE_TABLE)).toHaveLength(1));
    const promptHash = createHash('sha256').update(PROMPT).digest('hex');
    expect(inserts(JUDGE_SAMPLE_TABLE)[0].values).toEqual([
      {
        time: '2026-10-17 01:02:03.456',
        promptHash,
        prompt: PROMPT,
        browsingLevel: 3,
        baseModel: 'SDXL 1.0',
      },
    ]);
    await flush();
    expect(shadowRow().promptHash).toBe(promptHash);
  });

  it('flag on: a cache hit is captured too', async () => {
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
    await getResourceIntent({ prompt: PROMPT }, { ...CTX, judgeCapture: true });
    await vi.waitFor(() => expect(inserts(JUDGE_SAMPLE_TABLE)).toHaveLength(1));
  });

  it('a failed write is not logged, so the prompt never reaches a log', async () => {
    mockInsert.mockImplementation(async (arg: Insert) => {
      if (arg.table === JUDGE_SAMPLE_TABLE) throw new Error(`refused: ${PROMPT}`);
    });
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, { ...CTX, judgeCapture: true });
    await vi.waitFor(() => expect(inserts(JUDGE_SAMPLE_TABLE)).toHaveLength(1));
    await flush();
    for (const call of loggingMock.logToAxiom.mock.calls)
      expect(JSON.stringify(call)).not.toContain(PROMPT);
  });

  it('with no ClickHouse client the row is dropped, not logged', async () => {
    clickhouseState.present = false;
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, { ...CTX, judgeCapture: true });
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'resource-intent-shadow' }),
        'temp-search'
      )
    );
    for (const call of loggingMock.logToAxiom.mock.calls)
      expect(JSON.stringify(call)).not.toContain(PROMPT);
  });

  it('checkpoint mode is not captured', async () => {
    await getResourceIntent(
      { prompt: PROMPT, baseModel: 'SDXL 1.0', kind: 'checkpoint' },
      { ...CTX, judgeCapture: true }
    );
    await flush();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(inserts(JUDGE_SAMPLE_TABLE)).toHaveLength(0);
  });
});

describe('🔴 rows write only columns the shadow migrations declare', () => {
  const dir = path.resolve(__dirname, '../../clickhouse/migrations');
  const create = readFileSync(path.join(dir, '2026-09-29-resource-intent-shadow.sql'), 'utf8');
  const columnsOf = (files: string[]) =>
    files.flatMap((f) =>
      [...readFileSync(path.join(dir, f), 'utf8').matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map(
        (m) => m[1]
      )
    );
  const preV1 = new Set([
    ...create
      .slice(create.indexOf('resourceIntentShadow\n(') + 'resourceIntentShadow\n('.length)
      .split('\n)\nENGINE')[0]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]),
    ...columnsOf([
      '2026-10-08-resource-intent-shadow-stage3.sql',
      '2026-10-10-resource-intent-shadow-pool-merge.sql',
      '2026-10-11-resource-intent-shadow-checkpoint.sql',
    ]),
  ]);
  const v1Columns = columnsOf(['2026-10-17-resource-intent-shadow-v1.sql']);
  const declared = new Set([...preV1, ...v1Columns]);

  it('with every v1 flag off, HYBRID_10, POOL_MERGE and checkpoint rows write only pre-v1 columns', async () => {
    expect(v1Columns).toContain('literalTagCount');
    // Each run's arm is checked first, so a run silently served by another arm cannot pass.
    const runs: [
      Parameters<typeof getResourceIntent>[0],
      Parameters<typeof getResourceIntent>[1],
      Record<string, unknown> | null
    ][] = [
      [{ prompt: PROMPT, baseModel: 'SDXL 1.0' }, CTX, null],
      [
        { prompt: PROMPT, baseModel: 'SDXL 1.0' },
        { ...CTX, poolMerge: true },
        { arm: 'pool_merge' },
      ],
      [
        { prompt: PROMPT, baseModel: 'SDXL 1.0', kind: 'checkpoint' },
        CTX,
        { kind: 'checkpoint', arm: 'attach_bm' },
      ],
    ];
    for (const [input, ctx, arm] of runs) {
      mockInsert.mockClear();
      mockStage1();
      await getResourceIntent(input, ctx);
      await flush();
      if (arm) expect(shadowRow()).toMatchObject(arm);
      else expect(shadowRow()).not.toHaveProperty('arm');
      expect(
        Object.keys(shadowRow()).filter((k) => !preV1.has(k)),
        JSON.stringify(ctx)
      ).toEqual([]);
    }
  });

  it('a served v1 row', async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, V1);
    await flush();
    const extra = Object.keys(shadowRow()).filter((k) => !declared.has(k));
    expect(extra).toEqual([]);
    expect(Object.keys(shadowRow())).toContain('v1FallbackReason');
  });

  it('a shadowed POOL_MERGE row and a shadowed checkpoint row', async () => {
    mockStage1();
    await getResourceIntent({ prompt: PROMPT }, { ...CTX, poolMerge: true, v1Shadow: true });
    await flush();
    expect(Object.keys(shadowRow()).filter((k) => !declared.has(k))).toEqual([]);
    expect(Object.keys(shadowRow())).toContain('shadowLatencyMs');
    mockInsert.mockClear();
    await getResourceIntent(
      { prompt: PROMPT, baseModel: 'SDXL 1.0', kind: 'checkpoint' },
      { ...CTX, v1Shadow: true }
    );
    await flush();
    expect(Object.keys(shadowRow()).filter((k) => !declared.has(k))).toEqual([]);
  });
});
