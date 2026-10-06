import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type { SearchParams } from 'meilisearch';

/**
 * The candidate SEED: which documents `searchShortlistModels` hands `expandShortlist`.
 *
 * Two layers, because they fail differently:
 *   - query-shape tests pin what each of the two pages ASKS the index for;
 *   - a behavioural test runs the real matcher against a small in-memory index that
 *     honours the role filter, the sort array and the limit, so a change to the seed
 *     shows up as a change in the RETURNED shortlist rather than only in a spelling.
 *
 * The fake index understands exactly the filter clause and the sort fields this seed
 * uses and throws on any other sort field, so it cannot silently ignore a key it was
 * never taught. Its own controls are the first describe block below.
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

vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const {
  buildResourceIntentFilter,
  buildResourceIntentSeedQueries,
  findResourceIntentCandidates,
  mergeSeedHits,
} = await import('~/server/services/resource-intent-matcher.service');
const { RESOURCE_INTENT_MAX_SHORTLIST } = await import('~/server/schema/resource-intent.schema');

const COVERAGE = { next: false, member: false };
const BASE_MODEL = 'Pony';

type Label = {
  role: string;
  styleFamily: string;
  qualityScore: number;
  confidence: number;
};

type FakeDoc = {
  id: number;
  name: string;
  type: string;
  metrics: { thumbsUpCount: number };
  versions: { id: number; name: string; baseModel: string; canGenerate: boolean }[];
  insight: {
    qualityScore: number | null;
    role: string | null;
    styleFamily: string | null;
    modelVersionId: number | null;
  };
};

/** One single-version model; a label, when given, is projected the way the index does. */
const docOf = (
  modelId: number,
  versionId: number,
  thumbsUpCount: number,
  label?: Label,
  // Multi-version models: the versions, and which one the projected label came from.
  multi?: { versions: FakeDoc['versions']; labelVersionId: number }
) =>
  ({
    id: modelId,
    name: `model-${modelId}`,
    type: 'LORA',
    metrics: { thumbsUpCount },
    versions: multi?.versions ?? [
      { id: versionId, name: 'v1', baseModel: BASE_MODEL, canGenerate: true },
    ],
    insight: label
      ? {
          qualityScore: label.qualityScore,
          role: label.role,
          styleFamily: label.styleFamily,
          modelVersionId: multi?.labelVersionId ?? versionId,
        }
      : { qualityScore: null, role: null, styleFamily: null, modelVersionId: null },
  } satisfies FakeDoc);

const SORTABLE: Record<string, (doc: FakeDoc) => number | null> = {
  'insight.qualityScore': (doc) => doc.insight.qualityScore,
  'metrics.thumbsUpCount': (doc) => doc.metrics.thumbsUpCount,
};

/**
 * A minimal Meilisearch stand-in over `corpus`. Honours an `insight.role = "<x>"`
 * clause, the sort array (a null sorts LAST in both directions, as measured against
 * the production engine) and `limit`. Every other filter clause is ignored, which is
 * sound only because every corpus document passes the matcher's gates.
 */
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
      .filter((doc) => role === undefined || doc.insight.role === role)
      .slice()
      .sort((a, b) => {
        for (const { read, desc } of keys) {
          const va = read(a);
          const vb = read(b);
          if (va === vb) continue;
          if (va === null) return 1;
          if (vb === null) return -1;
          return desc ? vb - va : va - vb;
        }
        return 0;
      })
      .slice(0, params.limit ?? 20);
    return { hits, estimatedTotalHits: hits.length };
  };
}

/** Serve the label table from the same fixture the index was projected from. */
function serveLabels(labels: Map<number, Label>) {
  dbMock.dbRead.resourceInsight.findMany.mockImplementation((async (args: {
    where: { modelVersionId: { in: number[] } };
  }) =>
    args.where.modelVersionId.in.flatMap((versionId) => {
      const label = labels.get(versionId);
      return label ? [{ modelVersionId: versionId, ...label }] : [];
    })) as never);
}

const seedCalls = () => searchWithSignal.mock.calls.map((call) => call[2] as SearchParams);

beforeEach(() => {
  meiliHolder.client = { index: () => ({}) };
  searchWithSignal.mockReset();
  searchWithSignal.mockResolvedValue({ hits: [], estimatedTotalHits: 0 });
  dbMock.dbRead.resourceInsight.findMany.mockReset();
  dbMock.dbRead.resourceInsight.findMany.mockResolvedValue([]);
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

describe('the fake index — controls on the instrument', () => {
  const corpus = [
    docOf(1, 11, 5, { role: 'style', styleFamily: 'other', qualityScore: 0.2, confidence: 0.9 }),
    docOf(2, 21, 50),
    docOf(3, 31, 9, { role: 'clothing', styleFamily: 'other', qualityScore: 0.8, confidence: 0.9 }),
  ];
  const search = fakeIndex(corpus);

  it('honours the role clause', () => {
    expect(
      search({ filter: 'x AND insight.role = "clothing"', limit: 10 }).hits.map((d) => d.id)
    ).toEqual([3]);
  });

  it('honours the sort array, with nulls last', () => {
    expect(
      search({ sort: ['insight.qualityScore:desc'], limit: 10 }).hits.map((d) => d.id)
    ).toEqual([3, 1, 2]);
    expect(
      search({ sort: ['metrics.thumbsUpCount:desc'], limit: 10 }).hits.map((d) => d.id)
    ).toEqual([2, 3, 1]);
    // Nulls last in the ascending direction too (the engine's measured behaviour), even
    // though the seed only sorts descending.
    expect(search({ sort: ['insight.qualityScore:asc'], limit: 10 }).hits.map((d) => d.id)).toEqual(
      [1, 3, 2]
    );
  });

  it('honours the limit, and refuses a sort field it was not taught', () => {
    expect(search({ sort: ['metrics.thumbsUpCount:desc'], limit: 1 }).hits).toHaveLength(1);
    expect(() => search({ sort: ['metrics.downloadCount:desc'] })).toThrow(/unsupported/);
  });
});

describe('buildResourceIntentSeedQueries — what each page asks for', () => {
  const filter = buildResourceIntentFilter({
    modelTypes: ['LORA'],
    baseModels: [BASE_MODEL],
    browsingLevel: 3,
    coverage: COVERAGE,
  });

  it('🔴 the PURPOSE page carries the role filter AND the quality-first sort', () => {
    const { purpose } = buildResourceIntentSeedQueries({ filter, role: 'clothing', poolCap: 37 });
    expect(purpose.filter).toBe(`(${filter} AND insight.role = "clothing")`);
    expect(purpose.sort).toEqual(['insight.qualityScore:desc', 'metrics.thumbsUpCount:desc']);
    expect(purpose.limit).toBe(37);
  });

  it('🔴 the POPULARITY page is the gate filter alone, sorted by popularity alone', () => {
    const { popularity } = buildResourceIntentSeedQueries({
      filter,
      role: 'clothing',
      poolCap: 37,
    });
    expect(popularity.filter).toBe(filter);
    expect(popularity.sort).toEqual(['metrics.thumbsUpCount:desc']);
    expect(popularity.limit).toBe(37);
  });

  it('carries the REQUESTED role, not a fixed one', () => {
    const { purpose } = buildResourceIntentSeedQueries({ filter, role: 'style', poolCap: 37 });
    expect(purpose.filter).toBe(`(${filter} AND insight.role = "style")`);
  });
});

describe('mergeSeedHits — purpose first, popularity fill, one entry per model', () => {
  const hit = (id: number) => ({ id } as never);
  const ids = (hits: { id: number }[]) => hits.map((h) => h.id);

  it('🔴 keeps purpose hits first and popularity hits after, each in its own order', () => {
    expect(ids(mergeSeedHits([hit(7), hit(3)], [hit(9), hit(1)], 10))).toEqual([7, 3, 9, 1]);
  });

  it('🔴 dedupes by model id, keeping the PURPOSE position', () => {
    expect(ids(mergeSeedHits([hit(7), hit(3)], [hit(3), hit(9), hit(7), hit(1)], 10))).toEqual([
      7, 3, 9, 1,
    ]);
  });

  it('truncates to the pool width, so the merge is never wider than one page', () => {
    expect(ids(mergeSeedHits([hit(7), hit(3)], [hit(9), hit(1)], 3))).toEqual([7, 3, 9]);
    // A duplicate does not spend a slot: the fill reaches past it.
    expect(ids(mergeSeedHits([hit(7)], [hit(7), hit(9), hit(1)], 2))).toEqual([7, 9]);
  });
});

/**
 * A busy cell: more labeled `character` models than the pool is wide (every one scoring
 * higher than any `clothing` model), the given `clothing` models, and an unlabeled head
 * more popular than everything else.
 */
function busyCell(
  clothing: { modelId: number; versionId: number; quality: number; thumbs: number }[],
  extra: { docs: FakeDoc[]; labels: [number, Label][] } = { docs: [], labels: [] }
) {
  const labels = new Map<number, Label>();
  const corpus: FakeDoc[] = [];
  for (let i = 0; i < 30; i++) {
    const label = {
      role: 'character',
      styleFamily: 'photorealistic',
      qualityScore: 0.97 - i * 0.01,
      confidence: 0.82,
    };
    labels.set(110000 + i, label);
    corpus.push(docOf(1100 + i, 110000 + i, 400 - i, label));
  }
  for (const c of clothing) {
    const label = {
      role: 'clothing',
      styleFamily: 'photorealistic',
      qualityScore: c.quality,
      confidence: 0.71,
    };
    labels.set(c.versionId, label);
    corpus.push(docOf(c.modelId, c.versionId, c.thumbs, label));
  }
  for (let i = 0; i < 20; i++) corpus.push(docOf(5500 + i, 550000 + i, 9000 - i * 13));
  corpus.push(...extra.docs);
  for (const [versionId, label] of extra.labels) labels.set(versionId, label);

  const search = fakeIndex(corpus);
  searchWithSignal.mockImplementation(async (_index, _q, params: SearchParams) => search(params));
  serveLabels(labels);
}

describe('findResourceIntentCandidates — the seed reaches the shortlist', () => {
  const criteria = {
    criteriaVersion: 2,
    specHash: 'abc',
    role: 'clothing' as const,
    styleFamily: 'anime_manga' as const,
    modelTypes: ['LORA'] as never,
    baseModel: BASE_MODEL,
  };

  it('issues exactly the two pages, one with the role and one without', async () => {
    await findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 });
    const calls = seedCalls();
    expect(calls).toHaveLength(2);
    const purpose = calls.filter((c) => String(c.filter).includes('insight.role = "clothing"'));
    const popularity = calls.filter((c) => !String(c.filter).includes('insight.role'));
    expect(purpose).toHaveLength(1);
    expect(popularity).toHaveLength(1);
    expect(purpose[0].sort).toEqual(['insight.qualityScore:desc', 'metrics.thumbsUpCount:desc']);
    expect(popularity[0].sort).toEqual(['metrics.thumbsUpCount:desc']);
    // cap 5 -> a pool of 10, on both pages.
    expect(purpose[0].limit).toBe(10);
    expect(popularity[0].limit).toBe(10);
  });

  it('both pages take the clamped pool width at the maximum cap', async () => {
    await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: RESOURCE_INTENT_MAX_SHORTLIST,
    });
    // 2 x 255 would be 510; the clamp holds both pages to the shortlist maximum.
    expect(seedCalls().map((c) => c.limit)).toEqual([
      RESOURCE_INTENT_MAX_SHORTLIST,
      RESOURCE_INTENT_MAX_SHORTLIST,
    ]);
  });

  // 🔴 THE SATURATED CELL — the defect this seed exists to fix. A seed sorted on quality
  // alone fills the whole pool with `character` (all of which outscore `clothing`), so the
  // re-rank has nothing to promote and the response is five models for the wrong purpose.
  // Here the purpose page is SHORT (3 matches, pool of 10), so the popularity page fills.
  //
  // The groups are separated on the fields the seed sorts by: `clothing` is the least
  // popular and lowest-scoring labeled group, the unlabeled models the most popular. So
  // dropping the role clause, swapping the merge order, or sorting the fill by quality
  // each change the returned list.
  it('🔴 a busy cell returns the requested purpose first, then the popular unlabeled fill', async () => {
    busyCell([
      { modelId: 3301, versionId: 330001, quality: 0.61, thumbs: 5 },
      { modelId: 3302, versionId: 330002, quality: 0.54, thumbs: 7 },
      { modelId: 3303, versionId: 330003, quality: 0.47, thumbs: 6 },
    ]);

    const { entries, insightFallback } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 5,
    });

    expect(insightFallback).toBe(false);
    expect(entries.map((e) => e.versionId)).toEqual([
      // the three clothing models, by quality
      330001, 330002, 330003,
      // then the most popular unlabeled models, in popularity order
      550000, 550001,
    ]);
  });

  // 🔴 A FULL purpose page: more `clothing` matches (14) than the pool is wide (10), so the
  // purpose page's SORT decides which of them enter the pool, and the popularity page
  // contributes nothing. Quality and popularity run in OPPOSITE directions inside the
  // clothing group, so a purpose page sorted by thumbs would pool the ten least-good
  // matches and return a different five.
  it('🔴 a full purpose page admits its matches by QUALITY, and no fill reaches the pool', async () => {
    busyCell(
      Array.from({ length: 14 }, (_, i) => ({
        modelId: 3400 + i,
        versionId: 340000 + i,
        quality: 0.69 - i * 0.03,
        thumbs: 10 + i,
      }))
    );

    const { entries } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 5,
    });

    expect(entries.map((e) => e.versionId)).toEqual([340000, 340001, 340002, 340003, 340004]);
    // The label read is scoped to the pool: ten clothing versions, nothing unlabeled.
    const pooled = (
      dbMock.dbRead.resourceInsight.findMany.mock.calls[0][0] as {
        where: { modelVersionId: { in: number[] } };
      }
    ).where.modelVersionId.in;
    expect(pooled).toEqual(Array.from({ length: 10 }, (_, i) => 340000 + i));
  });

  // 🔴 The popularity page is fetched ONLY when the purpose page came back short. A full
  // purpose page fills the pool on its own, so a second request would be pure cost.
  it('🔴 a FULL purpose page issues no popularity request', async () => {
    busyCell(
      Array.from({ length: 14 }, (_, i) => ({
        modelId: 3400 + i,
        versionId: 340000 + i,
        quality: 0.69 - i * 0.03,
        thumbs: 10 + i,
      }))
    );

    await findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 });

    const calls = seedCalls();
    expect(calls).toHaveLength(1);
    expect(String(calls[0].filter)).toContain('insight.role = "clothing"');
  });

  it('🔴 a SHORT purpose page is followed by the popularity request, at the full width', async () => {
    busyCell([
      { modelId: 3301, versionId: 330001, quality: 0.61, thumbs: 5 },
      { modelId: 3302, versionId: 330002, quality: 0.54, thumbs: 7 },
    ]);

    await findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 });

    const calls = seedCalls();
    expect(calls).toHaveLength(2);
    expect(String(calls[0].filter)).toContain('insight.role = "clothing"');
    expect(String(calls[1].filter)).not.toContain('insight.role');
    expect(calls[1].sort).toEqual(['metrics.thumbsUpCount:desc']);
    // Not `poolCap - 2`: the merge drops popularity hits already on the purpose page.
    expect(calls[1].limit).toBe(10);
  });

  // 🔴 Either page failing fails the seed — there is no popularity-only fallback.
  it('🔴 a failing purpose page fails the seed and requests no popularity page', async () => {
    searchWithSignal.mockImplementation(async (_index, _q, params: SearchParams) => {
      if (String(params.filter).includes('insight.role')) throw new Error('page failed');
      return { hits: [], estimatedTotalHits: 0 };
    });

    await expect(
      findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 })
    ).rejects.toThrow('page failed');
    expect(seedCalls()).toHaveLength(1);
  });

  it('🔴 a failing popularity page (after a short purpose page) fails the seed', async () => {
    searchWithSignal.mockImplementation(async (_index, _q, params: SearchParams) => {
      if (!String(params.filter).includes('insight.role')) throw new Error('page failed');
      return { hits: [], estimatedTotalHits: 0 };
    });

    await expect(
      findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 })
    ).rejects.toThrow('page failed');
    expect(seedCalls()).toHaveLength(2);
  });

  // 🔴 The SEED ADVANTAGE of a cross-base-model match, pinned as the behaviour it is. Model
  // 3701's projected `clothing` role came from its SDXL version; the request is for Pony, so
  // only its UNLABELED Pony version enters the pool. The re-rank leaves that version neutral
  // — but neutral keeps seed order, so it leads every unlabeled fill candidate. (Not every
  // fill candidate: see the next case.) If this changes, it should change on purpose.
  it('🔴 a role matched on ANOTHER base model still seeds its neutral version ahead of the unlabeled fill', async () => {
    const clothingLabel = {
      role: 'clothing',
      styleFamily: 'photorealistic',
      qualityScore: 0.8,
      confidence: 0.9,
    };
    busyCell([], {
      docs: [
        docOf(3701, 370002, 1, clothingLabel, {
          versions: [
            { id: 370001, name: 'sdxl', baseModel: 'SDXL 1.0', canGenerate: true },
            { id: 370002, name: 'pony', baseModel: BASE_MODEL, canGenerate: true },
          ],
          labelVersionId: 370001,
        }),
      ],
      labels: [[370001, clothingLabel]],
    });

    const { entries } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 3,
    });

    expect(entries.map((e) => e.versionId)).toEqual([370002, 550000, 550001]);
  });

  // 🔴 The other direction of that seed advantage. It holds only WITHIN the neutral bucket:
  // the re-rank sorts bucket-first, and a fill version promoted on STYLE FAMILY alone (a
  // `character` label agreeing on `anime_manga`) lands in bucket 1 and outranks the neutral
  // purpose-page version. A demoted fill version (`character` + `photorealistic`, more
  // popular than every unlabeled one) sorts below it and below the unlabeled fill.
  it('🔴 that neutral version is outranked by a style-promoted fill version, and outranks a demoted one', async () => {
    const clothingLabel = {
      role: 'clothing',
      styleFamily: 'photorealistic',
      qualityScore: 0.8,
      confidence: 0.9,
    };
    const styleAgrees = {
      role: 'character',
      styleFamily: 'anime_manga',
      qualityScore: 0.5,
      confidence: 0.9,
    };
    const disagrees = {
      role: 'character',
      styleFamily: 'photorealistic',
      qualityScore: 0.6,
      confidence: 0.9,
    };
    busyCell([], {
      docs: [
        docOf(3701, 370002, 1, clothingLabel, {
          versions: [
            { id: 370001, name: 'sdxl', baseModel: 'SDXL 1.0', canGenerate: true },
            { id: 370002, name: 'pony', baseModel: BASE_MODEL, canGenerate: true },
          ],
          labelVersionId: 370001,
        }),
        docOf(5600, 560000, 9500, styleAgrees),
        docOf(5601, 560100, 9400, disagrees),
      ],
      labels: [
        [370001, clothingLabel],
        [560000, styleAgrees],
        [560100, disagrees],
      ],
    });

    // cap 4 -> pool of 8: the purpose page holds only 3701, the fill the 7 most popular.
    const { entries } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 4,
    });

    // 5601 is seeded ahead of every unlabeled version (it is more popular), so its absence
    // from the first four is the demotion putting it behind 370002 and the unlabeled fill.
    expect(entries.map((e) => e.versionId)).toEqual([560000, 370002, 550000, 550001]);
  });
});
