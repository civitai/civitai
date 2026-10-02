import { describe, expect, it, vi, beforeEach } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as CoverageSource from '~/server/services/generation/coverage-source';

/**
 * Stage-2 matcher tests. The matcher is the deterministic gate owner: Jev can
 * reorder/drop within its shortlist but never add — the cap, the per-version
 * gates and the filter are all enforced HERE, in code. The filter-string
 * assertions read the query the Meilisearch client is actually handed (the
 * pattern from resource-select.pricing-filter.test.ts).
 */

const searchWithSignal = vi.fn();
// Live-binding holder so a test can observe the meili-unconfigured path.
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

vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const {
  applyInsightRanking,
  buildResourceIntentFilter,
  expandShortlist,
  findResourceIntentCandidates,
} = await import('~/server/services/resource-intent-matcher.service');
const { RESOURCE_INTENT_MAX_SHORTLIST } = await import('~/server/schema/resource-intent.schema');

const COVERAGE = { next: false, member: false };

const shortlistHit = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 1,
    name: 'Test LoRA',
    type: 'LORA',
    metrics: { thumbsUpCount: 100 },
    versions: [{ id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
    ...overrides,
  } as never);

const meiliArgsOf = () =>
  (searchWithSignal.mock.calls[0][2] ?? {}) as {
    filter?: string;
    sort?: string[];
    limit?: number;
  };

beforeEach(() => {
  meiliHolder.client = { index: () => ({}) };
  searchWithSignal.mockReset();
  searchWithSignal.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });
  dbMock.dbRead.resourceInsight.findMany.mockReset();
  dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

describe('buildResourceIntentFilter — the deterministic gates reach Meilisearch', () => {
  it('emits availability, maturity, type+baseModel and celebrity clauses', () => {
    const filter = buildResourceIntentFilter({
      modelTypes: ['LORA', 'TextualInversion'],
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(filter).toContain('availability != "Private"');
    // The browsing-level bits, mirroring model.service's `nsfwLevel IN [...]`.
    expect(filter).toContain('nsfwLevel IN [1, 2]');
    expect(filter).toContain('type = "LORA"');
    expect(filter).toContain('versions.baseModel IN ["SDXL 1.0"]');
    expect(filter).toContain('canGenerate = true');
    expect(filter).toContain('NOT tags.name = "celebrity"');
  });

  it('omits the type clause when the role mapping has none', () => {
    const filter = buildResourceIntentFilter({
      modelTypes: null,
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(filter).not.toContain('type =');
    expect(filter).toContain('versions.baseModel IN ["SDXL 1.0"]');
  });

  it('omits the baseModel clause when no baseModel was supplied', () => {
    const filter = buildResourceIntentFilter({
      modelTypes: ['LORA'],
      baseModels: null,
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(filter).toContain('type = "LORA"');
    expect(filter).not.toContain('versions.baseModel');
  });

  it('is deterministic for identical inputs', () => {
    const a = buildResourceIntentFilter({
      modelTypes: ['LORA'],
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    const b = buildResourceIntentFilter({
      modelTypes: ['LORA'],
      baseModels: ['SDXL 1.0'],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    expect(a).toBe(b);
  });
});

describe('expandShortlist — determinism, cap, gates', () => {
  it('expands model hits to versions in hit order and is deterministic', () => {
    const hits = [
      shortlistHit({
        id: 1,
        versions: [
          { id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true },
          { id: 12, name: 'v2', baseModel: 'SDXL 1.0', canGenerate: true },
        ],
      }),
      shortlistHit({
        id: 2,
        versions: [{ id: 21, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
      }),
    ];
    const first = expandShortlist(hits, { baseModels: ['SDXL 1.0'], coverage: COVERAGE, cap: 50 });
    const second = expandShortlist(hits, { baseModels: ['SDXL 1.0'], coverage: COVERAGE, cap: 50 });
    expect(first.map((e) => e.versionId)).toEqual([11, 12, 21]);
    expect(second).toEqual(first);
  });

  it('enforces the cap exactly', () => {
    const hits = [
      shortlistHit({
        versions: Array.from({ length: 300 }, (_, i) => ({
          id: i + 1,
          name: `v${i}`,
          baseModel: 'SDXL 1.0',
          canGenerate: true,
        })),
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: RESOURCE_INTENT_MAX_SHORTLIST,
    });
    expect(entries).toHaveLength(RESOURCE_INTENT_MAX_SHORTLIST);
    expect(entries[0].versionId).toBe(1);
    expect(entries.at(-1)?.versionId).toBe(RESOURCE_INTENT_MAX_SHORTLIST);
  });

  it('drops versions whose baseModel does not match — a gate Jev cannot veto', () => {
    const hits = [
      shortlistHit({
        versions: [
          { id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true },
          { id: 12, name: 'v2', baseModel: 'Pony', canGenerate: true },
        ],
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries.map((e) => e.versionId)).toEqual([11]);
  });

  it('drops versions failing the per-version coverage gate', () => {
    const hits = [
      shortlistHit({
        versions: [
          { id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true },
          { id: 12, name: 'v2', baseModel: 'SDXL 1.0', canGenerate: false },
        ],
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries.map((e) => e.versionId)).toEqual([11]);
  });

  it('never returns duplicate version ids', () => {
    const hits = [
      shortlistHit({
        id: 1,
        versions: [{ id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
      }),
      shortlistHit({
        id: 2,
        versions: [{ id: 11, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
      }),
    ];
    const entries = expandShortlist(hits, {
      baseModels: ['SDXL 1.0'],
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries).toHaveLength(1);
  });
});

describe('findResourceIntentCandidates', () => {
  const criteria = {
    criteriaVersion: 2,
    specHash: 'abc',
    role: 'style' as const,
    styleFamily: 'anime_manga' as const,
    modelTypes: ['LORA', 'TextualInversion'] as never,
    baseModel: 'SDXL 1.0',
  };

  it('queries with the popularity sort and returns the capped shortlist', async () => {
    searchWithSignal.mockResolvedValue({ hits: [shortlistHit()], estimatedTotalHits: 1 });
    const entries = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    const args = meiliArgsOf();
    expect(args.sort).toEqual(['metrics.thumbsUpCount:desc']);
    expect(args.limit).toBeGreaterThanOrEqual(50);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ versionId: 11, modelType: 'LORA', baseModel: 'SDXL 1.0' });
  });

  it('returns [] without querying when the role is none', async () => {
    const entries = await findResourceIntentCandidates(
      { ...criteria, role: 'none', modelTypes: null },
      { browsingLevel: 3, coverage: COVERAGE, cap: 50 }
    );
    expect(entries).toEqual([]);
    expect(searchWithSignal).not.toHaveBeenCalled();
  });

  it('returns [] without querying when Meilisearch is not configured', async () => {
    meiliHolder.client = null;
    const entries = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries).toEqual([]);
    expect(searchWithSignal).not.toHaveBeenCalled();
  });

  it('surfaces a search failure as a thrown error (the service degrades)', async () => {
    searchWithSignal.mockRejectedValue(new Error('meili down'));
    await expect(
      findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 50 })
    ).rejects.toThrow('meili down');
  });
});

const entryOf = (versionId: number, thumbsUpCount: number) => ({
  versionId,
  modelId: versionId + 1,
  modelName: `model-${versionId}`,
  versionName: 'v1',
  baseModel: 'SDXL 1.0',
  modelType: 'LORA',
  thumbsUpCount,
});

const insightRow = (
  modelVersionId: number,
  row: { role: string; styleFamily: string; confidence: number; qualityScore: number }
) => ({ modelVersionId, ...row });

const insightMap = (...rows: ReturnType<typeof insightRow>[]) =>
  new Map(rows.map(({ modelVersionId, ...rest }) => [modelVersionId, rest]));

describe('applyInsightRanking — the label ordering policy', () => {
  const WANT = { role: 'style', styleFamily: 'anime_manga' } as const;

  it('ranks both-axis agreement over role-only over style-only over unlabeled over disagreement', () => {
    // Seeded in exactly the reverse of the expected order, and the qualityScores run
    // AGAINST it, so neither the seed nor quality alone can produce the assertion.
    const entries = [
      entryOf(55005, 91),
      entryOf(54004, 73),
      entryOf(53003, 64),
      entryOf(52002, 46),
      entryOf(51001, 38),
    ];
    const insights = insightMap(
      insightRow(51001, {
        role: 'style',
        styleFamily: 'anime_manga',
        confidence: 0.44,
        qualityScore: 0.11,
      }),
      insightRow(52002, {
        role: 'style',
        styleFamily: 'render_3d',
        confidence: 0.55,
        qualityScore: 0.22,
      }),
      insightRow(53003, {
        role: 'clothing',
        styleFamily: 'anime_manga',
        confidence: 0.66,
        qualityScore: 0.33,
      }),
      // 54004 carries no row at all.
      insightRow(55005, {
        role: 'character',
        styleFamily: 'pixel_retro',
        confidence: 0.77,
        qualityScore: 0.95,
      })
    );

    expect(applyInsightRanking(entries, insights, WANT).map((e) => e.versionId)).toEqual([
      51001, 52002, 53003, 54004, 55005,
    ]);
  });

  it('🔴 an `other` style family on both sides is not agreement', () => {
    const entries = [entryOf(61001, 84), entryOf(62002, 29)];
    const disagrees = insightMap(
      insightRow(61001, {
        role: 'character',
        styleFamily: 'other',
        confidence: 0.93,
        qualityScore: 0.87,
      })
    );
    // 62002 is unlabeled, and still outranks a confident both-axis disagreement.
    expect(
      applyInsightRanking(entries, disagrees, { role: 'style', styleFamily: 'other' }).map(
        (e) => e.versionId
      )
    ).toEqual([62002, 61001]);

    // Positive control: the same `other` request, with the ROLE agreeing, promotes.
    const agreesOnRole = insightMap(
      insightRow(61001, {
        role: 'style',
        styleFamily: 'other',
        confidence: 0.93,
        qualityScore: 0.87,
      })
    );
    expect(
      applyInsightRanking(entries, agreesOnRole, { role: 'style', styleFamily: 'other' }).map(
        (e) => e.versionId
      )
    ).toEqual([61001, 62002]);
  });

  it('uses qualityScore only to separate candidates inside one agreement bucket', () => {
    const entries = [entryOf(71001, 68), entryOf(72002, 42)];
    const insights = insightMap(
      insightRow(71001, {
        role: 'style',
        styleFamily: 'render_3d',
        confidence: 0.58,
        qualityScore: 0.31,
      }),
      insightRow(72002, {
        role: 'style',
        styleFamily: 'render_3d',
        confidence: 0.58,
        qualityScore: 0.82,
      })
    );
    expect(applyInsightRanking(entries, insights, WANT).map((e) => e.versionId)).toEqual([
      72002, 71001,
    ]);
  });
});

describe('findResourceIntentCandidates — the labels change the response', () => {
  const criteria = {
    criteriaVersion: 2,
    specHash: 'abc',
    role: 'style' as const,
    styleFamily: 'anime_manga' as const,
    modelTypes: ['LORA', 'TextualInversion'] as never,
    baseModel: 'SDXL 1.0',
  };
  const opts = { browsingLevel: 3, coverage: COVERAGE, cap: 50 };

  const hitFor = (modelId: number, versionId: number, thumbsUpCount: number) =>
    shortlistHit({
      id: modelId,
      metrics: { thumbsUpCount },
      versions: [{ id: versionId, name: 'v1', baseModel: 'SDXL 1.0', canGenerate: true }],
    });

  // Meilisearch hands these back popularity-descending, which is the seed order.
  const seed = [hitFor(7701, 10701, 97), hitFor(7702, 20802, 61), hitFor(7703, 30903, 23)];

  it('🔴 orders the shortlist by the labels, not by the popularity seed', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      // The most popular candidate is also the highest-quality one and agrees on neither axis.
      insightRow(10701, {
        role: 'character',
        styleFamily: 'pixel_retro',
        confidence: 0.81,
        qualityScore: 0.93,
      }),
      // 20802 carries no row — the ~99% case — and 30903 agrees on both axes.
      insightRow(30903, {
        role: 'style',
        styleFamily: 'anime_manga',
        confidence: 0.52,
        qualityScore: 0.37,
      }),
    ]);

    const entries = await findResourceIntentCandidates(criteria, opts);

    expect(entries.map((e) => e.versionId)).toEqual([30903, 20802, 10701]);
    // The control, named: that is the exact reverse of the order the seed produced.
    expect(entries.map((e) => e.thumbsUpCount)).toEqual([23, 61, 97]);
  });

  it('🔴 promotes a candidate the popularity seed ranked outside the cap', async () => {
    searchWithSignal.mockResolvedValue({
      hits: [...seed, hitFor(7704, 40904, 8)],
      estimatedTotalHits: 4,
    });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(20802, {
        role: 'clothing',
        styleFamily: 'render_3d',
        confidence: 0.66,
        qualityScore: 0.88,
      }),
      insightRow(40904, {
        role: 'style',
        styleFamily: 'anime_manga',
        confidence: 0.77,
        qualityScore: 0.44,
      }),
    ]);

    // cap 2 would have stopped the pool at 10701/20802, so 40904 is only reachable
    // because the pool is wider than the response.
    const entries = await findResourceIntentCandidates(criteria, { ...opts, cap: 2 });

    expect(entries.map((e) => e.versionId)).toEqual([40904, 10701]);
  });

  it('🔴 a label below the confidence floor is neutral, not a promotion', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed.slice(0, 2), estimatedTotalHits: 2 });
    const perfectAgreement = {
      role: 'style',
      styleFamily: 'anime_manga',
      qualityScore: 0.99,
    };

    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(20802, { ...perfectAgreement, confidence: 0.29 }),
    ]);
    const below = await findResourceIntentCandidates(criteria, opts);
    expect(below.map((e) => e.versionId)).toEqual([10701, 20802]);

    // Positive control on the same fixture: one step over the floor and it moves.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(20802, { ...perfectAgreement, confidence: 0.31 }),
    ]);
    const above = await findResourceIntentCandidates(criteria, opts);
    expect(above.map((e) => e.versionId)).toEqual([20802, 10701]);
  });

  it('🔴 asks only for fresh label rows, for exactly the pooled versions', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });

    await findResourceIntentCandidates(criteria, opts);

    expect(dbMock.dbRead.resourceInsight.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.resourceInsight.findMany.mock.calls[0][0]).toMatchObject({
      where: { modelVersionId: { in: [10701, 20802, 30903] }, stale: false },
    });
  });

  it('invariant guard: an all-unlabeled pool keeps the seed order exactly', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);

    const entries = await findResourceIntentCandidates(criteria, opts);

    expect(entries.map((e) => e.versionId)).toEqual([10701, 20802, 30903]);
  });

  it('🔴 keeps the seed order and logs when the label table is unreachable', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockRejectedValue(new Error('relation missing'));

    const entries = await findResourceIntentCandidates(criteria, opts);

    expect(entries.map((e) => e.versionId)).toEqual([10701, 20802, 30903]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-insight-read-failed' }),
      'temp-search'
    );
  });
});
