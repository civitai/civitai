import { readFileSync } from 'fs';
import path from 'path';
import type { SearchParams } from 'meilisearch';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as JevModule from '~/server/services/ai/jev';
import type {
  ResourceIntentAnswer,
  ResourceIntentCriteria,
  ResourceIntentRole,
} from '~/server/schema/resource-intent.schema';

/**
 * The M3 retrieval comparison: the metric math (every expectation a literal, computed
 * independently of this code — the McNemar values by exact rational arithmetic, the
 * PRNG values from a separate mulberry32 implementation), and the two-arm runner over
 * a small in-memory index (the fake-index pattern of
 * `src/server/services/__tests__/resource-intent-matcher.seed.test.ts`).
 */

const searchWithSignal = vi.fn();
const meiliHolder: { client: unknown } = { client: { index: () => ({}) } };

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  get searchClient() {
    return meiliHolder.client;
  },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));

const askJev = vi.fn();
vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => askJev(...args),
}));

const {
  evaluateRetrieval,
  exactMcNemarP,
  hitAtK,
  inRoleGold,
  M3_RETRIEVAL_PREREGISTRATION,
  pairedBootstrapCI,
  PREREGISTERED_RUN_PARAMS,
  preregistrationOverrides,
  purposeBeatsPopularity,
  rankedModelIds,
  reciprocalRankAtK,
  renderRetrievalPreregistration,
  renderRetrievalReport,
  requestBaseModel,
  runRetrievalArms,
  seededRandom,
} = await import('../eval-resource-intent-retrieval');
type Outcome = Awaited<ReturnType<typeof runRetrievalArms>>[number];
type GoldRow = Parameters<typeof runRetrievalArms>[0][number];
const { buildResourceIntentFilter } = await import(
  '~/server/services/resource-intent-matcher.service'
);
const { RESOURCE_INTENT_CRITERIA_VERSION, RESOURCE_INTENT_SPEC_HASH, ROLE_MODEL_TYPES } =
  await import('~/server/schema/resource-intent.schema');

// ---------------------------------------------------------------------------
// Metric math
// ---------------------------------------------------------------------------

describe('rankedModelIds / hitAtK / reciprocalRankAtK', () => {
  it('ranks DISTINCT model ids in shortlist order', () => {
    expect(rankedModelIds([5, 5, 7, 3, 7].map((modelId) => ({ modelId })))).toEqual([5, 7, 3]);
  });

  it('hit@K counts exactly the first K ids — the Kth is in, the (K+1)th is out', () => {
    const ranked = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    expect(hitAtK(ranked, new Set([10]), 10)).toBe(true);
    expect(hitAtK(ranked, new Set([10]), 9)).toBe(false);
    expect(hitAtK(ranked, new Set([11]), 10)).toBe(false);
    expect(hitAtK(ranked, new Set([99]), 50)).toBe(false);
    expect(hitAtK(ranked, new Set([99, 3]), 3)).toBe(true);
  });

  it('MRR@K is 1 / the rank of the FIRST gold id within K, else 0', () => {
    const ranked = [4, 8, 15, 16];
    expect(reciprocalRankAtK(ranked, new Set([15]), 4)).toBe(1 / 3);
    expect(reciprocalRankAtK(ranked, new Set([15]), 3)).toBe(1 / 3);
    expect(reciprocalRankAtK(ranked, new Set([15]), 2)).toBe(0);
    expect(reciprocalRankAtK(ranked, new Set([16, 4]), 4)).toBe(1);
    expect(reciprocalRankAtK(ranked, new Set([42]), 4)).toBe(0);
  });
});

describe('exactMcNemarP — exact two-sided binomial on the discordant pairs', () => {
  it.each([
    [0, 5, 0.0625],
    [1, 9, 0.021484375],
    [9, 1, 0.021484375],
    [2, 8, 0.109375],
    [5, 5, 1],
    [0, 0, 1],
    [3, 0, 0.25],
  ])('b=%i c=%i → p=%f (exact)', (b, c, p) => {
    expect(exactMcNemarP(b, c)).toBeCloseTo(p, 12);
  });

  it('stays exact at larger n, where a naive 0.5^n would underflow', () => {
    expect(exactMcNemarP(30, 60)).toBeCloseTo(0.002060265680963076, 12);
    expect(exactMcNemarP(40, 60)).toBeCloseTo(0.05688793364098079, 12);
    expect(exactMcNemarP(600, 700)).toBeCloseTo(0.0060157938610449525, 12);
  });
});

describe('seededRandom / pairedBootstrapCI', () => {
  it('seededRandom is mulberry32 (reference values from an independent implementation)', () => {
    const random = seededRandom(1);
    expect(random()).toBe(0.6270739405881613);
    expect(random()).toBe(0.002735721180215478);
    expect(random()).toBe(0.5274470399599522);
    expect(seededRandom(20261006)()).toBe(0.8267591667827219);
  });

  // Fine-grained values, so two seeds can land on different percentiles (a 0/1 fixture
  // this small has so few distinct resample means that two seeds often agree).
  const a = [0.91, 0.13, 0.77, 0.42, 0.68, 0.05, 0.99, 0.31, 0.56, 0.84];
  const b = [0.12, 0.4, 0.33, 0.18, 0.61, 0.02, 0.47, 0.29, 0.07, 0.36];

  it('is deterministic under a fixed seed, and moves with the seed', () => {
    const first = pairedBootstrapCI(a, b, { resamples: 2000, seed: 7 });
    const second = pairedBootstrapCI(a, b, { resamples: 2000, seed: 7 });
    expect(second).toEqual(first);
    const other = pairedBootstrapCI(a, b, { resamples: 2000, seed: 8 });
    expect(other).not.toEqual(first);
  });

  it('brackets the point estimate (0.281) and stays within [-1, 1]', () => {
    const ci = pairedBootstrapCI(a, b, { resamples: 2000, seed: 7 })!;
    expect(ci.lower).toBeLessThan(0.281);
    expect(ci.upper).toBeGreaterThan(0.281);
    expect(ci.lower).toBeGreaterThanOrEqual(-1);
    expect(ci.upper).toBeLessThanOrEqual(1);
  });

  it('collapses to the difference when every pair is identical', () => {
    expect(pairedBootstrapCI([1, 1, 1], [0, 0, 0], { resamples: 100, seed: 1 })).toEqual({
      lower: 1,
      upper: 1,
    });
    expect(pairedBootstrapCI([1, 0, 1], [1, 0, 1], { resamples: 100, seed: 1 })).toEqual({
      lower: 0,
      upper: 0,
    });
  });

  it('has no interval on an empty sample, and refuses unpaired arms', () => {
    expect(pairedBootstrapCI([], [], { resamples: 10, seed: 1 })).toBeNull();
    expect(() => pairedBootstrapCI([1], [1, 0], { resamples: 10, seed: 1 })).toThrow(/length/);
  });
});

describe('purposeBeatsPopularity — the pre-registered decision rule', () => {
  it('needs BOTH a positive difference AND p strictly under alpha', () => {
    expect(M3_RETRIEVAL_PREREGISTRATION.alpha).toBe(0.05);
    expect(purposeBeatsPopularity(0.05, 0.01)).toBe(true);
    expect(purposeBeatsPopularity(0.05, 0.05)).toBe(false);
    expect(purposeBeatsPopularity(0.05, 0.2)).toBe(false);
    expect(purposeBeatsPopularity(-0.05, 0.01)).toBe(false);
    expect(purposeBeatsPopularity(0, 0.01)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pre-registration
// ---------------------------------------------------------------------------

describe('the pre-registration', () => {
  it('pins the registered values', () => {
    expect(PREREGISTERED_RUN_PARAMS).toEqual({
      primaryK: 10,
      sampleSize: 1000,
      sampleDays: 30,
      bootstrapSeed: 20261006,
    });
    expect(M3_RETRIEVAL_PREREGISTRATION).toMatchObject({
      secondaryK: 50,
      cap: 50,
      bootstrapResamples: 10000,
      labeledIndexFloor: 100,
    });
  });

  it('reports every override, and none for the registered run', () => {
    expect(preregistrationOverrides(PREREGISTERED_RUN_PARAMS)).toEqual([]);
    expect(
      preregistrationOverrides({ ...PREREGISTERED_RUN_PARAMS, primaryK: 5, bootstrapSeed: 1 })
    ).toEqual(['primaryK: 10 -> 5', 'bootstrapSeed: 20261006 -> 1']);
  });

  it('🔴 is copied VERBATIM into docs/resource-intent-primitive.md', () => {
    const doc = readFileSync(
      path.resolve(__dirname, '../../docs/resource-intent-primitive.md'),
      'utf8'
    );
    expect(doc).toContain(renderRetrievalPreregistration());
  });
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const scoredOutcome = (
  imageId: number,
  over: Partial<Extract<Outcome, { status: 'scored' }>>
): Outcome => ({
  imageId,
  status: 'scored',
  role: 'style',
  baseModel: 'Pony',
  attachedCount: 2,
  inRoleCount: 1,
  goldModelIds: [100],
  goldLabeled: false,
  purposeModelIds: [],
  popularityModelIds: [],
  ...over,
});

/** A list of 20 distinct filler ids with `id` placed at 1-based `rank`. */
const rankedWith = (id: number | null, rank: number) =>
  Array.from({ length: 20 }, (_, i) => (id !== null && i === rank - 1 ? id : 1000 + i));

describe('evaluateRetrieval', () => {
  const outcomes: Outcome[] = [
    // P hit@10, Q miss (Q has it at 12) — discordant b; labeled
    scoredOutcome(1, {
      purposeModelIds: rankedWith(100, 1),
      popularityModelIds: rankedWith(100, 12),
      goldLabeled: true,
    }),
    // P hit, Q miss — b
    scoredOutcome(2, {
      purposeModelIds: rankedWith(100, 3),
      popularityModelIds: rankedWith(null, 1),
    }),
    // Q hit, P miss — c; labeled
    scoredOutcome(3, {
      purposeModelIds: rankedWith(null, 1),
      popularityModelIds: rankedWith(100, 2),
      goldLabeled: true,
    }),
    // both hit, identical lists
    scoredOutcome(4, {
      purposeModelIds: rankedWith(100, 5),
      popularityModelIds: rankedWith(100, 5),
    }),
    { imageId: 5, status: 'role_none', role: 'none', attachedCount: 1, inRoleCount: 0 },
    {
      imageId: 6,
      status: 'no_in_role_attachment',
      role: 'style',
      attachedCount: 3,
      inRoleCount: 0,
    },
    { imageId: 7, status: 'stage1_failed', role: null, attachedCount: 2, inRoleCount: 0 },
    { imageId: 8, status: 'arm_error', role: 'clothing', attachedCount: 2, inRoleCount: 2 },
    { imageId: 9, status: 'insight_fallback', role: 'style', attachedCount: 4, inRoleCount: 1 },
  ];

  it('counts exclusions, the out-of-role share and the discordant pairs', () => {
    const e = evaluateRetrieval(outcomes);
    expect(e.drawn).toBe(9);
    expect(e.excluded).toEqual({
      stage1_failed: 1,
      role_none: 1,
      no_in_role_attachment: 1,
      arm_error: 1,
      insight_fallback: 1,
    });
    // Rows with a non-none role: 1-4 (2 attached, 1 in role each), 6 (3/0), 8 (2/2), 9 (4/1).
    expect(e.outOfRole).toEqual({ attached: 17, excluded: 10 });
    expect(e.primary).toMatchObject({ n: 4, purposeHits: 3, popularityHits: 2, b: 2, c: 1 });
    expect(e.primary.difference).toBe(0.25);
    expect(e.primary.mcnemarP).toBe(1);
    expect(e.primary.purposeBeatsPopularity).toBe(false); // positive, but p = 1
    expect(e.identicalAtPrimaryK).toBe(1);
  });

  it('scores the secondary K and MRR on the same rows', () => {
    const e = evaluateRetrieval(outcomes);
    // At 50 the popularity arm also finds row 1's gold (rank 12).
    expect(e.secondary.k).toBe(50);
    expect(e.secondary.hit).toMatchObject({ b: 1, c: 1 });
    expect(e.secondary.hit.purposeHits).toBe(3);
    expect(e.secondary.hit.popularityHits).toBe(3);
    // MRR: P = (1 + 1/3 + 0 + 1/5) / 4; Q = (1/12 + 0 + 1/2 + 1/5) / 4.
    expect(e.secondary.purposeMrr).toBeCloseTo((1 + 1 / 3 + 1 / 5) / 4, 12);
    expect(e.secondary.popularityMrr).toBeCloseTo((1 / 12 + 1 / 2 + 1 / 5) / 4, 12);
  });

  it('stratifies by whether the gold carries a label', () => {
    const e = evaluateRetrieval(outcomes);
    expect(e.strata.labeled).toMatchObject({ n: 2, b: 1, c: 1 });
    expect(e.strata.unlabeled).toMatchObject({ n: 2, b: 1, c: 0 });
  });

  it('honours an overridden K — and stamps the report as not the registered run', () => {
    const params = { ...PREREGISTERED_RUN_PARAMS, primaryK: 2 };
    const e = evaluateRetrieval(outcomes, params);
    // At K=2: row 1 P hit, row 2 miss (rank 3), row 3 Q hit, row 4 neither (rank 5).
    expect(e.primary).toMatchObject({ purposeHits: 1, popularityHits: 1, b: 1, c: 1 });
    const report = renderRetrievalReport(e, { labeledIndexDocuments: 7000 });
    expect(report).toContain('NOT THE PRE-REGISTERED RUN');
    expect(report).toContain('primaryK: 10 -> 2');
    expect(
      renderRetrievalReport(evaluateRetrieval(outcomes), { labeledIndexDocuments: 7000 })
    ).not.toContain('NOT THE PRE-REGISTERED RUN');
  });

  it('declares a win only when the rule holds', () => {
    // 12 prompts PURPOSE-only hits, 0 the other way: p = 2 / 2^12 < 0.05.
    const wins = Array.from({ length: 12 }, (_, i) =>
      scoredOutcome(i + 1, {
        purposeModelIds: rankedWith(100, 1),
        popularityModelIds: rankedWith(null, 1),
      })
    );
    const e = evaluateRetrieval(wins);
    expect(e.primary).toMatchObject({ b: 12, c: 0 });
    expect(e.primary.mcnemarP).toBeCloseTo(2 / 4096, 12);
    expect(e.primary.purposeBeatsPopularity).toBe(true);
    expect(renderRetrievalReport(e, { labeledIndexDocuments: 7000 })).toContain(
      '**Decision (pre-registered rule): PURPOSE BEATS POPULARITY.**'
    );
  });
});

// ---------------------------------------------------------------------------
// The runner, over a fake index
// ---------------------------------------------------------------------------

const BASE_MODEL = 'Pony';
const COVERAGE = { next: false, member: false };
const ARM_OPTS = { browsingLevel: 3, coverage: COVERAGE, cap: 50 };

type FakeDoc = {
  id: number;
  name: string;
  type: string;
  metrics: { thumbsUpCount: number };
  versions: { id: number; name: string; baseModel: string; canGenerate: boolean }[];
  insight: { qualityScore: number | null; role: string | null; styleFamily: string | null };
};

const doc = (
  id: number,
  thumbsUpCount: number,
  label?: { role: string; qualityScore: number }
): FakeDoc => ({
  id,
  name: `model-${id}`,
  type: 'LORA',
  metrics: { thumbsUpCount },
  versions: [{ id: id * 10, name: 'v1', baseModel: BASE_MODEL, canGenerate: true }],
  insight: label
    ? { qualityScore: label.qualityScore, role: label.role, styleFamily: 'anime_manga' }
    : { qualityScore: null, role: null, styleFamily: null },
});

const SORTABLE: Record<string, (d: FakeDoc) => number | null> = {
  'insight.qualityScore': (d) => d.insight.qualityScore,
  'metrics.thumbsUpCount': (d) => d.metrics.thumbsUpCount,
};

/** Honours an `insight.role = "<x>"` clause, the sort array (nulls last) and `limit`. */
function fakeIndex(corpus: FakeDoc[]) {
  return (params: SearchParams) => {
    const filter = typeof params.filter === 'string' ? params.filter : '';
    const role = /insight\.role = "([^"]+)"/.exec(filter)?.[1];
    const keys = (params.sort ?? []).map((key) => {
      const [field, dir] = key.split(':');
      const read = SORTABLE[field];
      if (!read) throw new Error(`fake index: unsupported sort field ${field}`);
      return { read, desc: dir === 'desc' };
    });
    const hits = corpus
      .filter((d) => role === undefined || d.insight.role === role)
      .slice()
      .sort((x, y) => {
        for (const { read, desc } of keys) {
          const vx = read(x);
          const vy = read(y);
          if (vx === vy) continue;
          if (vx === null) return 1;
          if (vy === null) return -1;
          return desc ? vy - vx : vx - vy;
        }
        return 0;
      })
      .slice(0, params.limit ?? 20);
    return { hits, estimatedTotalHits: hits.length };
  };
}

// Model 4 is the ONLY model labeled for `style`, and the least popular: the purpose arm
// must seed it first, and a popularity arm that did no label ordering must keep it last.
const CORPUS = [
  doc(1, 900),
  doc(2, 800, { role: 'clothing', qualityScore: 0.9 }),
  doc(3, 700),
  doc(4, 10, { role: 'style', qualityScore: 0.8 }),
];

const labelRows = [
  {
    modelVersionId: 20,
    role: 'clothing',
    styleFamily: 'photorealistic',
    qualityScore: 0.9,
    confidence: 0.95,
  },
  {
    modelVersionId: 40,
    role: 'style',
    styleFamily: 'anime_manga',
    qualityScore: 0.8,
    confidence: 0.95,
  },
];

const intentFor = (role: ResourceIntentRole): ResourceIntentAnswer => ({
  needsResource: 0.9,
  role: { value: role, distribution: { [role]: 1 } },
  styleFamily: { value: 'anime_manga', distribution: { anime_manga: 1 } },
  contentType: { value: 'portrait_character', distribution: { portrait_character: 1 } },
  specificity: 3,
  injectionPresent: 0,
});

const criteriaFor = (
  role: ResourceIntentRole,
  baseModel: string | null
): ResourceIntentCriteria => ({
  criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
  specHash: RESOURCE_INTENT_SPEC_HASH,
  role,
  styleFamily: 'anime_manga',
  modelTypes: ROLE_MODEL_TYPES[role] ? [...ROLE_MODEL_TYPES[role]!] : null,
  baseModel,
});

const stage1As = (role: ResourceIntentRole) =>
  vi.fn(async (_prompt: string, baseModel: string | null) => ({
    intent: intentFor(role),
    criteria: criteriaFor(role, baseModel),
  }));

const row = (imageId: number, over: Partial<GoldRow> = {}): GoldRow => ({
  imageId,
  prompt: `prompt ${imageId}`,
  attachedModels: [
    { modelId: 900, modelType: 'Checkpoint' },
    { modelId: 4, modelType: 'LORA' },
  ],
  checkpointBaseModels: [BASE_MODEL],
  ...over,
});

const searchCalls = () => searchWithSignal.mock.calls.map((call) => call[2] as SearchParams);

beforeEach(() => {
  meiliHolder.client = { index: () => ({}) };
  searchWithSignal.mockReset();
  const search = fakeIndex(CORPUS);
  searchWithSignal.mockImplementation(async (_index: unknown, _q: string, params: SearchParams) =>
    search(params)
  );
  dbMock.dbRead.resourceInsight.findMany.mockReset();
  dbMock.dbRead.resourceInsight.findMany.mockImplementation((async (args: {
    where: { modelVersionId: { in: number[] } };
  }) => labelRows.filter((r) => args.where.modelVersionId.in.includes(r.modelVersionId))) as never);
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

describe('the fake index — controls on the instrument', () => {
  const search = fakeIndex(CORPUS);
  it('honours the role clause, the sort and the limit; refuses an unknown sort', () => {
    expect(search({ filter: 'x AND insight.role = "style"' }).hits.map((d) => d.id)).toEqual([4]);
    expect(
      search({ sort: ['metrics.thumbsUpCount:desc'], limit: 10 }).hits.map((d) => d.id)
    ).toEqual([1, 2, 3, 4]);
    expect(search({ sort: ['insight.qualityScore:desc'], limit: 2 }).hits.map((d) => d.id)).toEqual(
      [2, 4]
    );
    expect(() => search({ sort: ['metrics.downloadCount:desc'] })).toThrow(/unsupported/);
  });
});

describe('runRetrievalArms — the two arms', () => {
  it('🔴 the PURPOSE arm seeds the labeled match first; the POPULARITY arm keeps pure thumbs-up order', async () => {
    const [outcome] = await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set([4]),
    });
    expect(outcome).toMatchObject({
      status: 'scored',
      role: 'style',
      goldModelIds: [4],
      goldLabeled: true,
      // 4 promoted (role and style agree); 2 demoted (a confident label for another
      // purpose and another style).
      purposeModelIds: [4, 1, 3, 2],
      popularityModelIds: [1, 2, 3, 4],
    });
    // With K = 1 the arms disagree on this prompt, in PURPOSE's favour.
    const e = evaluateRetrieval([outcome], { ...PREREGISTERED_RUN_PARAMS, primaryK: 1 });
    expect(e.primary).toMatchObject({ b: 1, c: 0 });
  });

  it('🔴 the POPULARITY arm never reads labels and never asks for a quality sort or a role filter', async () => {
    await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: {
        purpose: async () => ({ entries: [], insightFallback: false }),
        popularity: (await import('../eval-resource-intent-retrieval')).popularityArm,
      },
    });
    expect(dbMock.dbRead.resourceInsight.findMany).not.toHaveBeenCalled();
    const calls = searchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].sort).toEqual(['metrics.thumbsUpCount:desc']);
    expect(String(calls[0].filter)).not.toContain('insight.');
  });

  it('🔴 both arms search under the SAME gate filter, derived from the same criteria', async () => {
    await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
    });
    const gate = buildResourceIntentFilter({
      modelTypes: ROLE_MODEL_TYPES.style,
      baseModels: [BASE_MODEL],
      browsingLevel: ARM_OPTS.browsingLevel,
      coverage: COVERAGE,
    });
    // PURPOSE: the purpose page, then (short page) the popularity fill. POPULARITY: one page.
    expect(searchCalls().map((c) => c.filter)).toEqual([
      `(${gate} AND insight.role = "style")`,
      gate,
      gate,
    ]);
    // Same pool width on every page.
    expect(searchCalls().map((c) => c.limit)).toEqual([100, 100, 100]);
  });

  it('caps both arms at the same response width, out of the same pool width', async () => {
    // cap 2 → pool 4: the whole 4-document corpus enters each pool; each arm returns 2.
    const [outcome] = await runRetrievalArms([row(1)], {
      stage1: stage1As('style'),
      armOpts: { ...ARM_OPTS, cap: 2 },
      labeledModelIds: new Set(),
    });
    expect(outcome).toMatchObject({ purposeModelIds: [4, 1], popularityModelIds: [1, 2] });
    expect(searchCalls().map((c) => c.limit)).toEqual([4, 4, 4]);
  });

  it('hands both arms the identical criteria and options objects', async () => {
    const purpose = vi.fn(async () => ({ entries: [], insightFallback: false }));
    const popularity = vi.fn(async () => ({ entries: [], insightFallback: false }));
    await runRetrievalArms([row(1)], {
      stage1: stage1As('clothing'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: { purpose, popularity },
    });
    expect(purpose).toHaveBeenCalledTimes(1);
    expect(popularity).toHaveBeenCalledTimes(1);
    const [pCriteria, pOpts] = purpose.mock.calls[0] as unknown as [ResourceIntentCriteria, object];
    const [qCriteria, qOpts] = popularity.mock.calls[0] as unknown as [
      ResourceIntentCriteria,
      object
    ];
    expect(qCriteria).toBe(pCriteria);
    expect(qOpts).toBe(pOpts);
    expect(pCriteria).toMatchObject({ role: 'clothing', baseModel: BASE_MODEL });
    expect(pOpts).toEqual(ARM_OPTS);
  });
});

describe('runRetrievalArms — exclusions', () => {
  it('🔴 skips role = none without running either arm', async () => {
    const purpose = vi.fn();
    const popularity = vi.fn();
    const outcomes = await runRetrievalArms([row(1)], {
      stage1: stage1As('none'),
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: { purpose, popularity },
    });
    expect(outcomes).toEqual([
      { imageId: 1, status: 'role_none', role: 'none', attachedCount: 2, inRoleCount: 0 },
    ]);
    expect(purpose).not.toHaveBeenCalled();
    expect(popularity).not.toHaveBeenCalled();
    expect(evaluateRetrieval(outcomes).excluded.role_none).toBe(1);
  });

  it('🔴 excludes out-of-role attachments from the gold, and counts them', async () => {
    const outcomes = await runRetrievalArms(
      [
        row(1), // Checkpoint 900 (out of role) + LORA 4 (in role)
        row(2, { attachedModels: [{ modelId: 900, modelType: 'Checkpoint' }] }),
      ],
      { stage1: stage1As('style'), armOpts: ARM_OPTS, labeledModelIds: new Set() }
    );
    expect(outcomes[0]).toMatchObject({
      status: 'scored',
      goldModelIds: [4],
      attachedCount: 2,
      inRoleCount: 1,
    });
    expect(outcomes[1]).toEqual({
      imageId: 2,
      status: 'no_in_role_attachment',
      role: 'style',
      attachedCount: 1,
      inRoleCount: 0,
    });
    const e = evaluateRetrieval(outcomes);
    expect(e.outOfRole).toEqual({ attached: 3, excluded: 2 });
    expect(e.excluded.no_in_role_attachment).toBe(1);
    expect(e.primary.n).toBe(1);
  });

  it('excludes and counts a failed stage 1, an erroring arm and a label-read fallback', async () => {
    const stage1 = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('vendor down'))
      .mockImplementation(async (_p: string, baseModel: string | null) => ({
        intent: intentFor('style'),
        criteria: criteriaFor('style', baseModel),
      }));
    const purpose = vi
      .fn()
      .mockRejectedValueOnce(new Error('index down'))
      .mockResolvedValueOnce({ entries: [], insightFallback: true });
    const popularity = vi.fn(async () => ({ entries: [], insightFallback: false }));
    const outcomes = await runRetrievalArms([row(1), row(2), row(3), row(4)], {
      stage1,
      armOpts: ARM_OPTS,
      labeledModelIds: new Set(),
      arms: { purpose, popularity },
    });
    expect(outcomes.map((o) => o.status)).toEqual([
      'stage1_failed',
      'stage1_failed',
      'arm_error',
      'insight_fallback',
    ]);
    expect(outcomes[1]).toMatchObject({ detail: 'vendor down' });
    expect(outcomes[2]).toMatchObject({ detail: 'index down' });
  });

  it('asks stage 1 with the single attached checkpoint base model, else none', async () => {
    const stage1 = stage1As('style');
    await runRetrievalArms(
      [
        row(1),
        row(2, { checkpointBaseModels: ['Pony', 'SDXL 1.0'] }),
        row(3, { checkpointBaseModels: [] }),
      ],
      {
        stage1,
        armOpts: ARM_OPTS,
        labeledModelIds: new Set(),
        arms: {
          purpose: async () => ({ entries: [], insightFallback: false }),
          popularity: async () => ({ entries: [], insightFallback: false }),
        },
      }
    );
    expect(stage1.mock.calls.map((call) => call[1])).toEqual(['Pony', null, null]);
    expect(requestBaseModel(row(9))).toBe('Pony');
  });

  it('inRoleGold dedupes by model and admits only the role’s types', () => {
    const gold = inRoleGold(
      row(1, {
        attachedModels: [
          { modelId: 4, modelType: 'LORA' },
          { modelId: 4, modelType: 'LORA' },
          { modelId: 5, modelType: 'Controlnet' },
          { modelId: 6, modelType: 'TextualInversion' },
        ],
      }),
      'style'
    );
    expect(gold.map((m) => m.modelId)).toEqual([4, 6]);
    expect(inRoleGold(row(1), 'none')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The CLI gate (main in ../eval-resource-intent-goldset)
// ---------------------------------------------------------------------------

describe('main — the --execute gate', () => {
  const runMain = async (args: string[]) => {
    const { main } = await import('../eval-resource-intent-goldset');
    const argv = process.argv;
    process.argv = ['node', 'goldset-under-test', ...args];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      return {
        result: await main().then(
          () => 'ok',
          (error: Error) => error
        ),
        log,
        warn,
      };
    } finally {
      process.argv = argv;
    }
  };

  beforeEach(() => {
    askJev.mockReset();
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  });

  it('without --execute prints the queries and the pre-registration, and spends nothing', async () => {
    const { result, log, warn } = await runMain([]);
    expect(result).toBe('ok');
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('Dry run.');
    expect(printed).toContain('-- retrieval gold');
    expect(printed).toContain(renderRetrievalPreregistration());
    expect(warn).not.toHaveBeenCalled();
    expect(askJev).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(searchWithSignal).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it('warns loudly when a flag overrides the pre-registration', async () => {
    const { log, warn } = await runMain(['--k', '5', '--retrieval-sample', '50']);
    const warned = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warned).toContain('OVERRIDE the pre-registration');
    expect(warned).toContain('primaryK: 10 -> 5');
    expect(warned).toContain('sampleSize: 1000 -> 50');
    log.mockRestore();
    warn.mockRestore();
  });

  it('refuses a malformed override instead of silently using the default', async () => {
    const { result, log, warn } = await runMain(['--k', 'ten']);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toContain('--k must be a positive integer');
    log.mockRestore();
    warn.mockRestore();
  });

  it('🔴 with --execute, a failed positive control aborts before any query or vendor call', async () => {
    const search = vi.fn(async () => ({ hits: [], estimatedTotalHits: 3 }));
    meiliHolder.client = { index: () => ({ search }) };
    const { result, log, warn } = await runMain(['--execute']);
    expect(String(result)).toContain('positive control FAILED: 3 models-index documents');
    // The control reads the field the PURPOSE page filters on.
    expect(search).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ filter: expect.stringContaining('insight.role IN [') })
    );
    expect(askJev).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it('with --execute and a passing control, proceeds to sample the gold', async () => {
    const search = vi.fn(async () => ({ hits: [], estimatedTotalHits: 7000 }));
    meiliHolder.client = { index: () => ({ search }) };
    const { result, log, warn } = await runMain(['--execute', '--limit', '2']);
    expect(result).toBe('ok');
    // stage-1 matched + unmatched, then the retrieval gold (empty here, so no label query).
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(3);
    log.mockRestore();
    warn.mockRestore();
  });
});
