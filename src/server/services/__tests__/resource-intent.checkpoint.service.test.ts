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
 * Checkpoint mode of the resource-intent service (`kind: 'checkpoint'`): no vendor call, which arm
 * runs, the cache key, the no-snapshot fallback, study mode, and the shadow row — and that the
 * add-on path is untouched. The matcher, the snapshot holder, Jev, redis, hydration and ClickHouse
 * are mocked at their seams; `resource-intent-checkpoint.seam.test.ts` runs the matcher for real.
 */

const mockAskJev = vi.fn();
const mockFindCandidates = vi.fn();
const mockPoolMerge = vi.fn();
const mockCheckpoint = vi.fn();
const mockGetResourceData = vi.fn();
const mockInsert = vi.fn();
const mockHolderResolve = vi.fn();
const mockStudyGet = vi.fn();
const mockCoverage = vi.fn();

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-matcher.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MatcherModule>()),
  findResourceIntentCandidates: (...args: unknown[]) => mockFindCandidates(...(args as [])),
  findPoolMergeCandidates: (...args: unknown[]) => mockPoolMerge(...(args as [])),
  findCheckpointCandidates: (...args: unknown[]) => mockCheckpoint(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-cooc/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof CoocHolder>()),
  coocSnapshotHolder: () => ({ resolve: mockHolderResolve }),
  coocStudySnapshots: () => ({ get: mockStudyGet }),
}));
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
  coverageAudience: (...args: unknown[]) => mockCoverage(...(args as [])),
}));

const {
  getResourceIntent,
  checkpointIntentCacheKey,
  COOC_FALLBACK_SNAPSHOT_KEY,
  CHECKPOINT_MODEL,
} = await import('~/server/services/resource-intent.service');
const { RESOURCE_INTENT_CHECKPOINT_SPEC_HASH } = await import(
  '~/server/services/resource-intent-checkpoint'
);
const { CHECKPOINT_ATTACH_BUILD_HASH } = await import(
  '~/server/services/resource-intent-cooc/checkpoint-attach'
);
const { RESOURCE_INTENT_SPEC_HASH } = await import('~/server/schema/resource-intent.schema');
const { RESOURCE_INTENT_STAGE3_SPEC_HASH } = await import(
  '~/server/services/resource-intent-stage3'
);
const { RESOURCE_INTENT_COOC_SPEC_HASH } = await import(
  '~/server/services/resource-intent-cooc/spec'
);

const BM = 'SynthEco';
const PROMPT = 'zephyr portrait of a knight';
const INPUT = { prompt: PROMPT, baseModel: BM, kind: 'checkpoint' as const };
const COVERAGE = { next: true, member: false };
const CTX = { browsingLevel: 3, coverage: COVERAGE };
const SNAPSHOT = 'a'.repeat(64);
const STUDY = 'b'.repeat(64);
const ATTACH_CANDS = [904, 902, 903];
const INDEX = { candidates: new Map([[BM, ATTACH_CANDS]]) };

const entry = (versionId: number, modelId: number) => ({
  versionId,
  modelId,
  modelName: `m${modelId}`,
  versionName: 'v1',
  baseModel: BM,
  modelType: 'Checkpoint',
  thumbsUpCount: 1,
});
const genResource = (id: number) => ({
  id,
  name: `version-${id}`,
  baseModel: BM,
  strength: 1,
  minStrength: -1,
  maxStrength: 2,
  trainedWords: [],
  clipSkip: 2,
  hasAccess: true,
  canGenerate: true,
  model: {
    id: 100 + id,
    name: `model-${id}`,
    type: 'Checkpoint',
    nsfw: false,
    poi: false,
    userId: 1,
  },
  air: `air:${id}`,
});

const served = (checkpoints: unknown = INDEX) => ({
  snapshot: { contentHash: SNAPSHOT, scores: {}, checkpoints },
  fallbackReason: null,
});
const fallback = (reason = 'no_snapshot') => ({ snapshot: null, fallbackReason: reason });

const keyOf = (terms: string[]) =>
  `packed:caches:jev-resource-intent:v1:${createHash('sha256')
    .update(terms.join('|'))
    .digest('hex')}`;

const shadowRow = () =>
  (mockInsert.mock.calls[0][0] as { values: Record<string, unknown>[] }).values[0];
const flush = () => vi.waitFor(() => expect(mockInsert).toHaveBeenCalled());

beforeEach(() => {
  mockAskJev.mockReset();
  mockFindCandidates.mockReset();
  mockPoolMerge.mockReset();
  mockCheckpoint.mockReset();
  mockCheckpoint.mockResolvedValue([entry(31, 904), entry(32, 902)]);
  mockGetResourceData.mockReset();
  mockGetResourceData.mockImplementation(async (ids: number[]) => ids.map(genResource));
  mockInsert.mockReset();
  mockHolderResolve.mockReset();
  mockHolderResolve.mockResolvedValue(served());
  mockStudyGet.mockReset();
  mockStudyGet.mockResolvedValue({ contentHash: STUDY, scores: {}, checkpoints: INDEX });
  mockCoverage.mockReset();
  mockCoverage.mockResolvedValue(COVERAGE);
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
});

describe('the spec hashes', () => {
  // Change detectors: the cache key and the shadow row rely on them moving with the serving
  // constants / the section's build. Update a literal deliberately — and for the build hash, run a
  // production build by hand, or checkpoint mode serves BASE_BM (`spec_mismatch`) until one lands.
  it('are pinned', () => {
    expect(RESOURCE_INTENT_CHECKPOINT_SPEC_HASH).toBe(
      '2853ffc327af48f32391eb471ce49ac77b9b8d79df0b91d6426da055ab9182e8'
    );
    expect(CHECKPOINT_ATTACH_BUILD_HASH).toBe(
      'e30973c3d16826992f661c77856baae9b7ec93e01b36484bbccd04fd6dc8839c'
    );
  });
});

describe('🔴 cache key', () => {
  const base = { baseModel: BM, browsingLevel: 3, width: 50, coverage: COVERAGE };
  const TERMS = ['checkpoint', 'attach_bm', BM, '3', '50', 'next:true', 'member:false'];

  it('carries the kind, arm, baseModel, level, width, coverage, snapshot and every spec — and no prompt', () => {
    expect(checkpointIntentCacheKey({ ...base, arm: 'attach_bm', snapshot: SNAPSHOT })).toBe(
      keyOf([
        ...TERMS,
        SNAPSHOT,
        RESOURCE_INTENT_COOC_SPEC_HASH,
        CHECKPOINT_ATTACH_BUILD_HASH,
        RESOURCE_INTENT_CHECKPOINT_SPEC_HASH,
      ])
    );
    expect(checkpointIntentCacheKey({ ...base, arm: 'base_bm' })).toBe(
      keyOf([
        'checkpoint',
        'base_bm',
        BM,
        '3',
        '50',
        'next:true',
        'member:false',
        RESOURCE_INTENT_CHECKPOINT_SPEC_HASH,
      ])
    );
    // Distinct values, so a mutant that swaps one spec term for another cannot pass.
    expect(
      new Set([
        SNAPSHOT,
        RESOURCE_INTENT_COOC_SPEC_HASH,
        CHECKPOINT_ATTACH_BUILD_HASH,
        RESOURCE_INTENT_CHECKPOINT_SPEC_HASH,
      ]).size
    ).toBe(4);
  });

  it('the service keys on the served snapshot, the width min(limit, 50) and coverage; never the prompt', async () => {
    const keys: string[] = [];
    for (const input of [
      INPUT,
      { ...INPUT, prompt: 'an entirely different prompt' },
      { ...INPUT, limit: 120 },
      { ...INPUT, limit: 51 },
    ]) {
      await getResourceIntent(input, CTX);
      keys.push(redisMock.redis.packed.set.mock.calls.at(-1)![0] as string);
    }
    const expected = checkpointIntentCacheKey({
      ...base,
      arm: 'attach_bm',
      snapshot: SNAPSHOT,
    });
    expect(keys).toEqual([expected, expected, expected, expected]);
    expect(redisMock.redis.packed.get).toHaveBeenCalledWith(expected);

    await getResourceIntent({ ...INPUT, limit: 10 }, CTX);
    expect(redisMock.redis.packed.set.mock.calls.at(-1)![0]).toBe(
      checkpointIntentCacheKey({ ...base, width: 10, arm: 'attach_bm', snapshot: SNAPSHOT })
    );
  });

  it('coverage is resolved BEFORE the cache read when not supplied, and keys the entry', async () => {
    redisMock.redis.packed.get.mockResolvedValue({ planted: true }); // unparseable → a miss
    await getResourceIntent(INPUT, { browsingLevel: 3 });
    expect(mockCoverage).toHaveBeenCalledTimes(1);
    expect(redisMock.redis.packed.get).toHaveBeenCalledWith(
      checkpointIntentCacheKey({ ...base, arm: 'attach_bm', snapshot: SNAPSHOT })
    );
    mockCoverage.mockResolvedValue({ next: false, member: true });
    await getResourceIntent(INPUT, { browsingLevel: 3 });
    expect(redisMock.redis.packed.get.mock.calls.at(-1)![0]).toBe(
      checkpointIntentCacheKey({
        ...base,
        coverage: { next: false, member: true },
        arm: 'attach_bm',
        snapshot: SNAPSHOT,
      })
    );
  });

  it('a fallback is keyed apart from any snapshot', async () => {
    mockHolderResolve.mockResolvedValue(fallback());
    await getResourceIntent(INPUT, CTX);
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
      checkpointIntentCacheKey({ ...base, arm: 'attach_bm', snapshot: COOC_FALLBACK_SNAPSHOT_KEY })
    );
  });
});

describe('🔴 add-on mode is untouched', () => {
  it('no kind and kind addon: the add-on path runs; no checkpoint search, key or shadow field', async () => {
    for (const input of [
      { prompt: PROMPT, baseModel: BM },
      { prompt: PROMPT, baseModel: BM, kind: 'addon' as const },
    ]) {
      mockAskJev.mockRejectedValueOnce(new Error('timeout')); // stage 1 runs, and degrades
      const result = await getResourceIntent(input, CTX);
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
      // Literal terms, not the key function: the add-on key must not gain a checkpoint term.
      expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
        keyOf([PROMPT, BM, '3', '50', RESOURCE_INTENT_SPEC_HASH, RESOURCE_INTENT_STAGE3_SPEC_HASH])
      );
      expect(Object.keys(shadowRow())).not.toContain('kind');
      expect(Object.keys(shadowRow())).not.toContain('checkpointSpecHash');
      expect(Object.keys(shadowRow())).not.toContain('arm');
      mockInsert.mockClear();
      redisMock.redis.packed.set.mockClear();
    }
    expect(mockAskJev).toHaveBeenCalledTimes(2);
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockHolderResolve).not.toHaveBeenCalled();
  });
});

describe('ATTACH_BM with a served snapshot', () => {
  it('🔴 no vendor call; the snapshot candidates for the baseModel reach the matcher; 1 h cache', async () => {
    const result = await getResourceIntent(INPUT, CTX);
    expect(mockAskJev).not.toHaveBeenCalled();
    expect(mockFindCandidates).not.toHaveBeenCalled();
    expect(mockPoolMerge).not.toHaveBeenCalled();
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockCheckpoint.mock.calls[0][0]).toEqual({
      arm: 'attach_bm',
      baseModel: BM,
      attachCandidates: ATTACH_CANDS,
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    expect(result).toEqual({
      degraded: false,
      insightFallback: false,
      kind: 'checkpoint',
      checkpointArm: 'attach_bm',
      coocFallback: false,
      intent: null,
      criteria: null,
      suggestions: [genResource(31), genResource(32)].map((r) =>
        expect.objectContaining({ versionId: r.id })
      ),
      noneProbability: null,
      model: CHECKPOINT_MODEL,
      criteriaVersion: 2,
    });
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 3600 });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-cooc-fallback' }),
      'temp-search'
    );
  });

  it('a baseModel the snapshot has no attachments for hands the matcher an empty list, not null', async () => {
    await getResourceIntent({ ...INPUT, baseModel: 'OtherEco' }, CTX);
    expect(mockCheckpoint.mock.calls[0][0]).toMatchObject({ attachCandidates: [] });
  });
});

describe('🔴 ATTACH_BM with no servable section: BASE_BM, flagged, 60 s, reason logged', () => {
  it.each([
    ['no snapshot at all', fallback('load_failed'), 'load_failed'],
    ['a snapshot without a checkpoint section', served(null), 'spec_mismatch'],
  ])('%s', async (_label, holder, reason) => {
    mockHolderResolve.mockResolvedValue(holder);
    const result = await getResourceIntent(INPUT, CTX);
    expect(mockCheckpoint.mock.calls[0][0]).toMatchObject({
      arm: 'attach_bm',
      attachCandidates: null,
    });
    expect(result).toMatchObject({
      degraded: false,
      coocFallback: true,
      checkpointArm: 'attach_bm',
    });
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      { type: 'resource-intent-cooc-fallback', reason, kind: 'checkpoint' },
      'temp-search'
    );
    await flush();
    expect(shadowRow()).toMatchObject({
      arm: 'attach_bm',
      coocSnapshotHash: '',
      coocFallback: 1,
      coocFallbackReason: reason,
    });
  });
});

describe('BASE_BM (the comparator arm)', () => {
  it('reads no snapshot — not even a study one — and carries no coocFallback', async () => {
    const result = await getResourceIntent(INPUT, {
      ...CTX,
      checkpointArm: 'base_bm',
      coocSnapshotId: STUDY,
    });
    expect(mockHolderResolve).not.toHaveBeenCalled();
    expect(mockStudyGet).not.toHaveBeenCalled();
    expect(mockAskJev).not.toHaveBeenCalled();
    expect(mockCheckpoint.mock.calls[0][0]).toMatchObject({
      arm: 'base_bm',
      attachCandidates: null,
    });
    expect(result).toMatchObject({ degraded: false, kind: 'checkpoint', checkpointArm: 'base_bm' });
    expect('coocFallback' in result).toBe(false);
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
      checkpointIntentCacheKey({
        arm: 'base_bm',
        baseModel: BM,
        browsingLevel: 3,
        width: 50,
        coverage: COVERAGE,
      })
    );
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 3600 });
    await flush();
    // The migration's contract: a base_bm row reads no snapshot and carries no cooc spec.
    expect(shadowRow()).toMatchObject({
      arm: 'base_bm',
      kind: 'checkpoint',
      coocSnapshotHash: '',
      coocSpecHash: '',
      coocFallback: 0,
      coocFallbackReason: '',
    });
  });
});

describe('🔴 study mode (ATTACH_BM)', () => {
  it('serves the study snapshot section, keyed by its hash, never asking the holder', async () => {
    mockStudyGet.mockResolvedValue({
      contentHash: STUDY,
      scores: {},
      checkpoints: { candidates: new Map([[BM, [77]]]) },
    });
    const result = await getResourceIntent(INPUT, { ...CTX, coocSnapshotId: STUDY });
    expect(mockStudyGet.mock.calls[0][0]).toBe(STUDY);
    expect(mockHolderResolve).not.toHaveBeenCalled();
    expect(mockCheckpoint.mock.calls[0][0]).toMatchObject({ attachCandidates: [77] });
    expect(result).toMatchObject({ degraded: false, coocFallback: false });
    expect(redisMock.redis.packed.set.mock.calls[0][0]).toBe(
      checkpointIntentCacheKey({
        arm: 'attach_bm',
        baseModel: BM,
        browsingLevel: 3,
        width: 50,
        coverage: COVERAGE,
        snapshot: STUDY,
      })
    );
  });

  it.each([
    [
      'the study snapshot cannot be served',
      () => mockStudyGet.mockRejectedValue(new Error('pin has passed')),
    ],
    [
      'the study snapshot has no checkpoint section',
      () => mockStudyGet.mockResolvedValue({ contentHash: STUDY, scores: {}, checkpoints: null }),
    ],
  ])('fails closed when %s — no search, no cache, no fallback', async (_label, arrange) => {
    arrange();
    redisMock.redis.packed.get.mockResolvedValue({ planted: true });
    const result = await getResourceIntent(INPUT, { ...CTX, coocSnapshotId: STUDY });
    expect(result).toEqual({
      degraded: true,
      insightFallback: false,
      kind: 'checkpoint',
      checkpointArm: 'attach_bm',
      coocFallback: false,
      intent: null,
      criteria: null,
      suggestions: [],
      noneProbability: null,
      model: 'checkpoint-unavailable',
      criteriaVersion: 2,
    });
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockHolderResolve).not.toHaveBeenCalled();
    expect(mockAskJev).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.get).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource-intent-degraded',
        degradedReason: 'cooc_study_snapshot',
        model: 'checkpoint-unavailable',
      }),
      'temp-search'
    );
    await flush();
    expect(shadowRow()).toMatchObject({
      degraded: 1,
      degradedReason: 'cooc_study_snapshot',
      arm: 'attach_bm',
      kind: 'checkpoint',
      coocSnapshotHash: STUDY,
      coocFallback: 0,
    });
  });
});

describe('checkpoint degrade and cache hit', () => {
  it('a search failure degrades for 60 s with its own reason', async () => {
    mockCheckpoint.mockRejectedValue(new Error('search down'));
    const result = await getResourceIntent(INPUT, CTX);
    expect(result).toMatchObject({
      degraded: true,
      suggestions: [],
      kind: 'checkpoint',
      coocFallback: false,
      model: 'checkpoint-unavailable',
    });
    expect(redisMock.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 60 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'resource-intent-degraded',
        degradedReason: 'checkpoint_error',
        model: 'checkpoint-unavailable',
      }),
      'temp-search'
    );
    await flush();
    expect(shadowRow()).toMatchObject({
      degraded: 1,
      degradedReason: 'checkpoint_error',
      model: 'checkpoint-unavailable',
    });
  });

  it('a cache hit serves the entry with no search and no write; the row keeps its arm', async () => {
    const cached = {
      degraded: false,
      insightFallback: false,
      kind: 'checkpoint',
      checkpointArm: 'attach_bm',
      coocFallback: false,
      intent: null,
      criteria: null,
      suggestions: [{ versionId: 31 }],
      noneProbability: null,
      model: CHECKPOINT_MODEL,
      criteriaVersion: 2,
    };
    redisMock.redis.packed.get.mockResolvedValue(cached);
    const result = await getResourceIntent(INPUT, CTX);
    expect(result).toEqual(cached);
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(redisMock.redis.packed.set).not.toHaveBeenCalled();
    await flush();
    expect(shadowRow()).toMatchObject({ arm: 'attach_bm', kind: 'checkpoint', shortlistCount: 1 });
  });
});

describe('shadow row', () => {
  it('🔴 a checkpoint row writes exactly the columns the four shadow migrations declare', async () => {
    const dir = path.resolve(__dirname, '../../clickhouse/migrations');
    const create = readFileSync(path.join(dir, '2026-09-29-resource-intent-shadow.sql'), 'utf8');
    const added = [
      '2026-10-08-resource-intent-shadow-stage3.sql',
      '2026-10-10-resource-intent-shadow-pool-merge.sql',
      '2026-10-11-resource-intent-shadow-checkpoint.sql',
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
    expect(added.slice(9)).toEqual(['kind', 'checkpointSpecHash']);

    await getResourceIntent(INPUT, CTX);
    await flush();
    expect(new Set(Object.keys(shadowRow()))).toEqual(new Set([...created, ...added]));
    expect(shadowRow()).toMatchObject({
      kind: 'checkpoint',
      checkpointSpecHash: RESOURCE_INTENT_CHECKPOINT_SPEC_HASH,
      arm: 'attach_bm',
      coocSnapshotHash: SNAPSHOT,
      coocSpecHash: RESOURCE_INTENT_COOC_SPEC_HASH,
      poolMergeSpecHash: '',
      coocFallback: 0,
      coocFallbackReason: '',
      specHash: '',
      stage3SpecHash: '',
      specVersion: 0,
      baseModel: BM,
      model: CHECKPOINT_MODEL,
      role: '',
      shortlistCount: 2,
      suggestionIds: [31, 32],
      promptHash: createHash('sha256').update(PROMPT).digest('hex'),
    });
  });
});
