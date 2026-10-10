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
// The two floors live in the leaf, not in the module under test, and are imported from
// there rather than through a re-export — see that module's header for why there is one
// import path and not two.
const { RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE, RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE } =
  await import('~/server/services/resource-insight');
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

  // The seed's QUERY SHAPE is pinned in ./resource-intent-matcher.seed.test.ts, against an
  // in-memory index that honours the sort array. Every hit fixture in THIS file is served
  // as the seed page as-is, so here the seed order is the fixture order.
  it('returns the capped shortlist from the seed', async () => {
    searchWithSignal.mockResolvedValue({ hits: [shortlistHit()], estimatedTotalHits: 1 });
    const { entries } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ versionId: 11, modelType: 'LORA', baseModel: 'SDXL 1.0' });
  });

  it('returns [] without querying when the role is none', async () => {
    const result = await findResourceIntentCandidates(
      { ...criteria, role: 'none', modelTypes: null },
      { browsingLevel: 3, coverage: COVERAGE, cap: 50 }
    );
    // 🔴 Asserted on the WHOLE return, not just `.entries`. When this function
    // returned a bare array, `toEqual([])` covered everything it could report; the
    // move to a result object silently narrowed that, and `insightFallback: true`
    // on this early return then passed the entire suite. No label read happens
    // here, so the only honest value is `false` — and a `true` would shorten the
    // cache TTL for every `role: 'none'` response.
    expect(result).toEqual({
      entries: [],
      insightFallback: false,
      promotableVersions: 0,
      pool: [],
      basePool: [],
    });
    expect(searchWithSignal).not.toHaveBeenCalled();
  });

  it('returns [] without querying when Meilisearch is not configured', async () => {
    meiliHolder.client = null;
    const result = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    // Whole return, for the same reason as the role-none case above.
    expect(result).toEqual({
      entries: [],
      insightFallback: false,
      promotableVersions: 0,
      pool: [],
      basePool: [],
    });
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
    // Seeded in exactly the reverse of the expected order, and the qualityScores and
    // confidences run AGAINST it, so no single-field descending sort can produce the
    // assertion. A REVERSED index tiebreak still would — the all-unlabeled test in the
    // suite below is what kills that one.
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
    // 62002 is unlabeled, and still outranks a both-axis disagreement at 0.93.
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

  it('uses qualityScore to separate candidates inside one agreement bucket', () => {
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

  // Served as the seed page, so this IS the seed order.
  const seed = [hitFor(7701, 10701, 97), hitFor(7702, 20802, 61), hitFor(7703, 30903, 23)];

  it('🔴 orders the shortlist by the labels, not by the seed order', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      // The first-seeded candidate is also the highest-quality one and agrees on neither axis.
      insightRow(10701, {
        role: 'character',
        styleFamily: 'pixel_retro',
        confidence: 0.81,
        qualityScore: 0.93,
      }),
      // 20802 carries no row — the unlabeled majority of a pool, though NOT the
      // "~99% case" an earlier version of this comment called it: that rate is
      // corpus-wide, and in-pool coverage measures 33-45% (see
      // `applyInsightRanking`'s docstring). 30903 agrees on both axes.
      insightRow(30903, {
        role: 'style',
        styleFamily: 'anime_manga',
        confidence: 0.52,
        qualityScore: 0.37,
      }),
    ]);

    const { entries } = await findResourceIntentCandidates(criteria, opts);

    expect(entries.map((e) => e.versionId)).toEqual([30903, 20802, 10701]);
  });

  it('🔴 promotes a candidate the seed ranked outside the cap', async () => {
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
    const { entries } = await findResourceIntentCandidates(criteria, { ...opts, cap: 2 });

    expect(entries.map((e) => e.versionId)).toEqual([40904, 10701]);
  });

  // 🔴 The below-floor row sits in the MIDDLE of a three-candidate seed on purpose,
  // and that position is load-bearing in both directions. On the last candidate,
  // neutral and demoted are indistinguishable (`return 0` -> `return -1` survived).
  // On the first, neutral and quality-leaked are indistinguishable (reading
  // `qualityScore` for a neutral bucket survived). From the middle, one assertion
  // kills both: a demotion sends it last, a quality leak sends it first.
  it('🔴 a label below the promote floor is neutral — not demoted, and its quality unread', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    const perfectAgreement = {
      role: 'style',
      styleFamily: 'anime_manga',
      qualityScore: 0.99,
    };

    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(20802, { ...perfectAgreement, confidence: 0.29 }),
    ]);
    const { entries: below } = await findResourceIntentCandidates(criteria, opts);
    expect(below.map((e) => e.versionId)).toEqual([10701, 20802, 30903]);

    searchWithSignal.mockResolvedValue({ hits: seed.slice(0, 2), estimatedTotalHits: 2 });

    // The floor is inclusive: exactly at it, the same row IS read. This is the arm
    // that kills a `<` -> `<=` mutant.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(20802, {
        ...perfectAgreement,
        confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE,
      }),
    ]);
    const { entries: atFloor } = await findResourceIntentCandidates(criteria, opts);
    expect(atFloor.map((e) => e.versionId)).toEqual([20802, 10701]);

    // Positive control on the same fixture: over the floor it moves the same way.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(20802, { ...perfectAgreement, confidence: 0.31 }),
    ]);
    const { entries: above } = await findResourceIntentCandidates(criteria, opts);
    expect(above.map((e) => e.versionId)).toEqual([20802, 10701]);
  });

  // 🔴 This is the guard the `stale: false` clause CANNOT provide: nothing in the
  // repo sets `stale = true`, so that clause excludes no row today and a row
  // written under a superseded taxonomy is read. Demoting on a value this build
  // cannot interpret would bury the whole labeled population — the catalogue's
  // high-usage head — beneath the unlabeled majority.
  //
  // 🔴 Each arm varies ONE field. An earlier version set both to unknown strings at
  // once, which cannot attribute the behaviour: `styleFamily ? -1 : 0` and
  // `role && styleFamily ? -1 : 0` both survived it, and the second of those is a
  // DIFFERENT rule from the one the code implements.
  it('🔴 demotion turns on the role alone, and only on a recognised AND ACTUAL role', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed.slice(0, 2), estimatedTotalHits: 2 });
    // Named for the floor it clears, not for the word the doc used to use: 0.84 is
    // well above the demote floor, but the BUCKET is not a "confident" one — at a 0.30
    // floor it selects most label rows.
    const overDemoteFloor = { confidence: 0.84, qualityScore: 0.76 };

    // (i) role unrecognised, styleFamily recognised and disagreeing -> neutral.
    // Kills `styleFamily ? -1 : 0`, which would demote here.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(10701, {
        ...overDemoteFloor,
        role: 'retired_role_from_an_older_spec',
        styleFamily: 'pixel_retro',
      }),
    ]);
    expect(
      (await findResourceIntentCandidates(criteria, opts)).entries.map((e) => e.versionId)
    ).toEqual([10701, 20802]);

    // (ii) role recognised and disagreeing, styleFamily unrecognised -> DEMOTED.
    // The role is the evidence, so an uninterpretable style family does not rescue
    // it. Kills `role && styleFamily ? -1 : 0`, which would stay neutral here.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(10701, {
        ...overDemoteFloor,
        role: 'control_guidance',
        styleFamily: 'retired_style_from_an_older_spec',
      }),
    ]);
    expect(
      (await findResourceIntentCandidates(criteria, opts)).entries.map((e) => e.versionId)
    ).toEqual([20802, 10701]);

    // (iii) both unrecognised -> neutral. The production shape of a taxonomy bump.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(10701, {
        ...overDemoteFloor,
        role: 'retired_role_from_an_older_spec',
        styleFamily: 'retired_style_from_an_older_spec',
      }),
    ]);
    expect(
      (await findResourceIntentCandidates(criteria, opts)).entries.map((e) => e.versionId)
    ).toEqual([10701, 20802]);

    // 🔴 (iv) role `none` -> neutral. It IS in the option list, so a plain membership
    // test demotes on it — but it is the labeller's "I could not place this", not
    // evidence of a different purpose, and demoting on it would make being labelled
    // a penalty. The labelling pass asks with the full option list and persists the
    // answer unfiltered, so this row shape is reachable, not hypothetical.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(10701, { ...overDemoteFloor, role: 'none', styleFamily: 'pixel_retro' }),
    ]);
    expect(
      (await findResourceIntentCandidates(criteria, opts)).entries.map((e) => e.versionId)
    ).toEqual([10701, 20802]);
  });

  // 🔴 The other half of the `none` decision, and the half the natural refactor
  // deletes. "A `none` row is neutral" reads like an early `if (role === 'none')
  // return 0` placed BEFORE the agreement is computed — which is tidier than the
  // trailing conjunct the code uses, silently drops this promotion, and keeps every
  // other test in the segment green, because no other fixture pairs `role: 'none'`
  // with a MATCHING style family. The style question has its own option list with no
  // `none` in it, so a style family here is a positive answer to a different
  // question, not a second decline.
  it('🔴 a `none` role still promotes when its STYLE family agrees', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(30903, {
        role: 'none',
        styleFamily: 'anime_manga',
        confidence: 0.64,
        qualityScore: 0.19,
      }),
    ]);

    const { entries } = await findResourceIntentCandidates(criteria, opts);

    // 30903 is seeded LAST, so leading is only explicable by the style promotion.
    expect(entries.map((e) => e.versionId)).toEqual([30903, 10701, 20802]);
  });

  // 🔴 `quality: insight && bucket !== 0 ? …` applies inside BOTH labeled buckets.
  // With only ever one demoted row in a fixture, `bucket !== 0` -> `bucket > 0`
  // changed nothing observable and the docstring's claim went unpinned.
  it('🔴 qualityScore separates two candidates inside the DEMOTE bucket too', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      // Both disagree above the demote floor, so both demote; the seed order says 10701 first
      // and the quality scores say 20802 first.
      insightRow(10701, {
        role: 'control_guidance',
        styleFamily: 'pixel_retro',
        confidence: 0.71,
        qualityScore: 0.18,
      }),
      insightRow(20802, {
        role: 'clothing',
        styleFamily: 'render_3d',
        confidence: 0.63,
        qualityScore: 0.86,
      }),
    ]);

    const { entries } = await findResourceIntentCandidates(criteria, opts);

    // 30903 is unlabeled, so it leads both demotions; quality then orders them.
    expect(entries.map((e) => e.versionId)).toEqual([30903, 20802, 10701]);
  });

  it('scopes the label read to exactly the pooled versions, in one query', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });

    await findResourceIntentCandidates(criteria, opts);

    expect(dbMock.dbRead.resourceInsight.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.resourceInsight.findMany.mock.calls[0][0]).toMatchObject({
      where: { modelVersionId: { in: [10701, 20802, 30903] }, stale: false },
    });
  });

  // Green at `origin/main` too — trivially, since the baseline reads no labels at
  // all — so an invariant guard by the red/green matrix. It is the only cover on
  // `loadResourceInsights`' empty-id early return, which no mutant in the battery
  // targets, so a query on an empty `in: []` would otherwise go unnoticed.
  it('issues no label query at all when the pool is empty', async () => {
    searchWithSignal.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });

    const result = await findResourceIntentCandidates(criteria, opts);

    // Whole return: an empty pool skips the label read entirely, which is NOT a
    // fallback — the read did not fail, it never happened.
    expect(result).toEqual({
      entries: [],
      insightFallback: false,
      promotableVersions: 0,
      pool: [],
      basePool: [],
    });
    expect(dbMock.dbRead.resourceInsight.findMany).not.toHaveBeenCalled();
  });

  // 🔴 Asserted on the POOL — the id list handed to the label read — as well as on
  // the Meilisearch page. An earlier version read only the page width, which at the
  // maximum cap saturated against a since-deleted ceiling and so observed neither
  // the multiplier nor the clamp: dropping `clampResourceIntentCap` from the pool
  // passed it, which is the one thing its name promised to catch.
  it('🔴 the pool is twice the cap, and the clamp binds at the shortlist maximum', async () => {
    // More hits than any pool width, so the pool is bounded by the cap arithmetic
    // and never by the fixture.
    const wide = Array.from({ length: 600 }, (_, i) => hitFor(900000 + i, 500000 + i, 600 - i));
    const pooledIds = () =>
      (
        dbMock.dbRead.resourceInsight.findMany.mock.calls[0][0] as {
          where: { modelVersionId: { in: number[] } };
        }
      ).where.modelVersionId.in;

    searchWithSignal.mockResolvedValue({ hits: wide, estimatedTotalHits: 600 });
    await findResourceIntentCandidates(criteria, { ...opts, cap: 50 });
    expect(pooledIds()).toHaveLength(100);
    // And each seed page's limit is one document per targeted version — no multiplier
    // (this reads the first page; both are pinned in ./resource-intent-matcher.seed.test.ts).
    expect(meiliArgsOf().limit).toBe(100);

    searchWithSignal.mockReset();
    searchWithSignal.mockResolvedValue({ hits: wide, estimatedTotalHits: 600 });
    dbMock.dbRead.resourceInsight.findMany.mockReset();
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);

    // At the maximum accepted limit the clamp binds: 2 x 255 would be 510, so the
    // pool collapses to the cap and the ordering can only reshuffle the visible page.
    await findResourceIntentCandidates(criteria, { ...opts, cap: RESOURCE_INTENT_MAX_SHORTLIST });
    expect(pooledIds()).toHaveLength(RESOURCE_INTENT_MAX_SHORTLIST);
    expect(meiliArgsOf().limit).toBe(RESOURCE_INTENT_MAX_SHORTLIST);
  });

  // 🔴 Green at `origin/main` too, so it is an invariant guard by the red/green
  // matrix — but it is NOT dead weight: most ordering expectations in this file are
  // the exact reverse of their seed, so `.sort((a, b) => b.index - a.index)` passes
  // them and fails here. Do not delete it in a coverage prune.
  it('an all-unlabeled pool keeps the seed order exactly — kills a reversed index tiebreak', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);

    const { entries } = await findResourceIntentCandidates(criteria, opts);

    expect(entries.map((e) => e.versionId)).toEqual([10701, 20802, 30903]);
  });

  // 🔴 BOTH caps, and both are load-bearing. At cap 50 the fallback's slice is a
  // no-op, so that arm is the one that pins "the fallback returns the pool whole" —
  // a mutant that FILTERS the pool is invisible at cap 2, where only two of three
  // hits are asserted. At cap 2 the slice is observable, which is what pins the
  // fallback's own `.slice`: unsliced it would hand stage 3 up to twice the caller's
  // cap in options and hydrate the same, with the shadow row recording the pool
  // width as the shortlist size. Tightening one arm must not replace the other.
  it('🔴 keeps the seed order whole, caps it, and logs once PER FAILURE when the label table is unreachable', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockRejectedValue(new Error('relation missing'));

    const { entries: whole } = await findResourceIntentCandidates(criteria, opts);
    expect(whole.map((e) => e.versionId)).toEqual([10701, 20802, 30903]);

    const { entries: capped } = await findResourceIntentCandidates(criteria, { ...opts, cap: 2 });
    expect(capped.map((e) => e.versionId)).toEqual([10701, 20802]);

    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(2);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource-intent-insight-read-failed' }),
      'temp-search'
    );
  });

  // 🔴 The seam half of the fallback. The log above reaches an operator, not the
  // CALLER, and the caller is the one that owns this response's cache TTL — so a
  // fallback that returns a correctly-shaped shortlist and no flag is
  // indistinguishable from success at the only boundary that can act on it. Both
  // arms are here because `insightFallback: true` hardcoded would pass the first
  // alone, and `false` hardcoded would pass the second alone.
  it('🔴 reports insightFallback when the label read fails, and not when it succeeds', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });

    dbMock.dbRead.resourceInsight.findMany.mockRejectedValue(new Error('relation missing'));
    const failed = await findResourceIntentCandidates(criteria, opts);
    expect(failed.insightFallback).toBe(true);
    // And it is a flag ON a usable shortlist, not an error: the entries are there.
    expect(failed.entries.map((e) => e.versionId)).toEqual([10701, 20802, 30903]);

    // Control arm: a label read that SUCCEEDS and reorders reports no fallback.
    dbMock.dbRead.resourceInsight.findMany.mockReset();
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(30903, {
        role: 'style',
        styleFamily: 'anime_manga',
        confidence: 0.58,
        qualityScore: 0.41,
      }),
    ]);
    const ordered = await findResourceIntentCandidates(criteria, opts);
    expect(ordered.insightFallback).toBe(false);
    expect(ordered.entries.map((e) => e.versionId)).toEqual([30903, 10701, 20802]);
  });

  // 🔴 A label read that SUCCEEDS but returns nothing is NOT a fallback. Without
  // this arm, `insightFallback = pool.every(unlabeled)` — the shape someone reaches
  // for when wiring the shadow columns — passes every other assertion in this file,
  // and would then cut the cache TTL for the single commonest response there is.
  it('🔴 an empty label result is not a fallback', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed, estimatedTotalHits: 3 });
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);

    const result = await findResourceIntentCandidates(criteria, opts);

    expect(result.insightFallback).toBe(false);
    expect(result.entries).toHaveLength(3);
  });

  // 🔴 F1: the two directions now read SEPARATE constants. 🔴 DO NOT DELETE THIS IN A
  // COVERAGE PRUNE — mutation-measured, its demote arms are the ONLY coverage the
  // demote branch has: deleting that branch's floor check, and flipping its `<` to
  // `<=`, each fail exactly one test in the whole suite, this one. The branch is new
  // code from the constant split and nothing else reaches it.
  //
  // What this test does NOT prove, so the label is honest in both directions: it
  // cannot tell which constant each branch reads (a mutant swapping them is green
  // across the whole suite while both hold the same value), and it does not pin the demote VALUE
  // (0.3 → 0.5 is also green — deliberate, since that value is explicitly unargued).
  // Its first arm, the promote side under its own floor, IS redundant with "a label
  // below the promote floor is neutral" above; the demote arms are not redundant with
  // anything. Both arms derive from the constants rather than the literal 0.3, so
  // whichever floor moves first the other keeps asserting the right boundary.
  it('reads the promote floor on the promote side and the demote floor on the demote side', async () => {
    searchWithSignal.mockResolvedValue({ hits: seed.slice(0, 2), estimatedTotalHits: 2 });

    // Promote side, one step under its own floor -> neutral, so the seed order holds.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(20802, {
        role: 'style',
        styleFamily: 'anime_manga',
        confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE - 0.01,
        qualityScore: 0.97,
      }),
    ]);
    expect(
      (await findResourceIntentCandidates(criteria, opts)).entries.map((e) => e.versionId)
    ).toEqual([10701, 20802]);

    // Demote side, one step under ITS floor -> neutral, so 10701 keeps the lead it
    // would lose to a demotion.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(10701, {
        role: 'control_guidance',
        styleFamily: 'pixel_retro',
        confidence: RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE - 0.01,
        qualityScore: 0.12,
      }),
    ]);
    expect(
      (await findResourceIntentCandidates(criteria, opts)).entries.map((e) => e.versionId)
    ).toEqual([10701, 20802]);

    // Demote side AT its floor -> demoted. This is the arm that makes the one above
    // a boundary assertion rather than a claim that demotion never happens.
    dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([
      insightRow(10701, {
        role: 'control_guidance',
        styleFamily: 'pixel_retro',
        confidence: RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE,
        qualityScore: 0.12,
      }),
    ]);
    expect(
      (await findResourceIntentCandidates(criteria, opts)).entries.map((e) => e.versionId)
    ).toEqual([20802, 10701]);
  });
});

describe('findResourceIntentCandidates — basePool, the hybrid fill', () => {
  const criteria = {
    criteriaVersion: 2,
    specHash: 'abc',
    role: 'style' as const,
    styleFamily: 'anime_manga' as const,
    modelTypes: ['LORA'] as never,
    baseModel: 'SDXL 1.0',
  };

  /** Model `id` with versions; `ok: false` versions are on another base model (gate fails). */
  const hit = (id: number, versions: { id: number; ok: boolean }[]) =>
    shortlistHit({
      id,
      metrics: { thumbsUpCount: 10_000 - id },
      versions: versions.map((v) => ({
        id: v.id,
        name: `v${v.id}`,
        baseModel: v.ok ? 'SDXL 1.0' : 'Pony',
        canGenerate: true,
      })),
    });

  /** Serves `corpus` in order, honouring each request's `limit`. */
  const serve = (corpus: unknown[]) =>
    searchWithSignal.mockImplementation(async (_index, _q, params: { limit: number }) => ({
      hits: corpus.slice(0, params.limit),
      estimatedTotalHits: corpus.length,
    }));
  const limits = () => searchWithSignal.mock.calls.map((c) => (c[2] as { limit: number }).limit);

  it('takes the FIRST gate-passing version of each model, skips models with none, in seed order', async () => {
    serve([
      hit(1, [
        { id: 11, ok: false },
        { id: 12, ok: true },
        { id: 13, ok: true },
      ]),
      hit(2, [{ id: 21, ok: false }]),
      hit(3, [{ id: 31, ok: true }]),
    ]);
    const result = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    expect(result.basePool.map((e) => [e.modelId, e.versionId])).toEqual([
      [1, 12],
      [3, 31],
    ]);
    // Its own 500-document page, every time — even when the seed page already held every match.
    expect(limits()).toEqual([100, 500]);
  });

  it('takes the first 2 × cap models of its own page, even when the seed page would do', async () => {
    serve(Array.from({ length: 300 }, (_, i) => hit(i + 1, [{ id: 1000 + i, ok: true }])));
    const result = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 5,
    });
    expect(result.basePool.map((e) => e.modelId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(limits()).toEqual([10, 500]);
  });

  it('🔴 reaches past the seed page, under the seed page filter and sort', async () => {
    // Seed page = 10 docs (cap 5 × 2), of which only models 3 and 7 pass the gate; the
    // other passing models sit deeper. The 500-document page must reach them, in order.
    const passing = new Set([3, 7, 12, 15, 40, 41]);
    serve(
      Array.from({ length: 600 }, (_, i) => hit(i + 1, [{ id: 1000 + i, ok: passing.has(i + 1) }]))
    );
    const result = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 5,
    });
    expect(result.basePool.map((e) => e.modelId)).toEqual([3, 7, 12, 15, 40, 41]);
    expect(limits()).toEqual([10, 500]);
    const [seedArgs, deepArgs] = searchWithSignal.mock.calls.map((c) => c[2] as object);
    expect({ ...deepArgs, limit: 10 }).toEqual(seedArgs);
    // The SHORTLIST still comes from the seed page alone.
    expect(result.pool.map((e) => e.modelId)).toEqual([3, 7]);
  });

  it('🔴 follows its OWN page when the two pages order tied documents differently', async () => {
    // Nothing guarantees Meilisearch orders tied documents the same at limit 10 and 500,
    // so the fake does not: the seed page leads 2, 1; the 500-document page 1, 2.
    const docs = Array.from({ length: 30 }, (_, i) => hit(i + 1, [{ id: 1000 + i, ok: true }]));
    // A real tie: models 1 and 2 share a score, so both orders are valid sorts.
    (docs[1] as unknown as { metrics: { thumbsUpCount: number } }).metrics.thumbsUpCount = 9_999;
    const seedOrder = [docs[1], docs[0], ...docs.slice(2)];
    searchWithSignal.mockImplementation(async (_index, _q, params: { limit: number }) => ({
      hits: (params.limit === 500 ? docs : seedOrder).slice(0, params.limit),
      estimatedTotalHits: docs.length,
    }));
    const result = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 5,
    });
    expect(result.basePool.map((e) => e.modelId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.pool.map((e) => e.modelId)).toEqual([2, 1, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('a failing deep page fails the call like any other search failure (the service degrades)', async () => {
    const corpus = Array.from({ length: 600 }, (_, i) =>
      hit(i + 1, [{ id: 1000 + i, ok: i === 2 }])
    );
    searchWithSignal
      .mockResolvedValueOnce({ hits: corpus.slice(0, 10), estimatedTotalHits: 600 })
      .mockRejectedValueOnce(new Error('meili down'));
    await expect(
      findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 })
    ).rejects.toThrow('meili down');
  });

  it('is returned on a label-read fallback too', async () => {
    serve([hit(1, [{ id: 11, ok: true }])]);
    dbMock.dbRead.resourceInsight.findMany.mockRejectedValue(new Error('relation missing'));
    const result = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 50,
    });
    expect(result.insightFallback).toBe(true);
    expect(result.basePool.map((e) => e.versionId)).toEqual([11]);
  });
});
