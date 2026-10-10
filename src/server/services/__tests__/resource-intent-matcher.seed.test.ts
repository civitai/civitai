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
 *   - query-shape tests pin what the one seed page ASKS the index for;
 *   - behavioural tests run the real matcher against a small in-memory index that
 *     honours a role filter, the sort array and the limit, so a change to the seed
 *     shows up as a change in the POOL and the RETURNED shortlist rather than only in a
 *     spelling.
 *
 * The fake index also honours the role clause and the `insight.qualityScore` sort, so a
 * seed that reintroduces either is graded on what it returns rather than dying on an
 * unsupported field. It throws on any other sort field, so it cannot
 * silently ignore a key it was never taught. Its own controls are the first describe
 * block below.
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

const { buildResourceIntentFilter, findResourceIntentCandidates } = await import(
  '~/server/services/resource-intent-matcher.service'
);
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
const docOf = (modelId: number, versionId: number, thumbsUpCount: number, label?: Label) =>
  ({
    id: modelId,
    name: `model-${modelId}`,
    type: 'LORA',
    metrics: { thumbsUpCount },
    versions: [{ id: versionId, name: 'v1', baseModel: BASE_MODEL, canGenerate: true }],
    insight: label
      ? {
          qualityScore: label.qualityScore,
          role: label.role,
          styleFamily: label.styleFamily,
          modelVersionId: versionId,
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

/**
 * A busy cell: more labeled `character` models than the pool is wide, the given `clothing`
 * models, and an unlabeled head more popular than everything else.
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

/** The version ids the label read was scoped to — i.e. the pool, in seed order. */
const pooledVersionIds = () =>
  (
    dbMock.dbRead.resourceInsight.findMany.mock.calls[0][0] as {
      where: { modelVersionId: { in: number[] } };
    }
  ).where.modelVersionId.in;

describe('findResourceIntentCandidates — the seed reaches the shortlist', () => {
  const criteria = {
    criteriaVersion: 2,
    specHash: 'abc',
    role: 'clothing' as const,
    styleFamily: 'anime_manga' as const,
    modelTypes: ['LORA'] as never,
    baseModel: BASE_MODEL,
  };

  it('🔴 issues exactly two pages, each the gate filter alone, sorted by popularity alone', async () => {
    await findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 });
    const calls = seedCalls();
    // The seed page, then the hybrid fill's own 500-document page.
    expect(calls).toHaveLength(2);
    const gates = buildResourceIntentFilter({
      modelTypes: ['LORA'],
      baseModels: [BASE_MODEL],
      browsingLevel: 3,
      coverage: COVERAGE,
    });
    for (const call of calls) {
      expect(call.filter).toBe(gates);
      expect(String(call.filter)).not.toContain('insight.');
      expect(call.sort).toEqual(['metrics.thumbsUpCount:desc']);
    }
    // cap 5 -> a pool of 10.
    expect(calls.map((c) => c.limit)).toEqual([10, 500]);
  });

  it('the page takes the clamped pool width at the maximum cap', async () => {
    await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: RESOURCE_INTENT_MAX_SHORTLIST,
    });
    // 2 x 255 would be 510; the clamp holds the seed page to the shortlist maximum.
    expect(seedCalls().map((c) => c.limit)).toEqual([RESOURCE_INTENT_MAX_SHORTLIST, 500]);
  });

  // 🔴 REGRESSION — the M3 v2 failure. Fourteen `clothing` matches would fill the 10-wide
  // pool on their own, and a purpose-first seed admitted only them, evicting the popular
  // unlabeled models a user is most likely to have attached. The seed is now the
  // popularity page alone, so those models stay in the pool and the role-matched ones,
  // all less popular than the pool's last member, do not enter it.
  it('🔴 role matches that would fill the pool do not evict the popular unlabeled models', async () => {
    busyCell(
      Array.from({ length: 14 }, (_, i) => ({
        modelId: 3400 + i,
        versionId: 340000 + i,
        quality: 0.69 - i * 0.03,
        thumbs: 10 + i,
      }))
    );

    const { entries, insightFallback } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 5,
    });

    expect(pooledVersionIds()).toContain(550000);
    expect(pooledVersionIds()).toEqual([
      550000, 550001, 550002, 550003, 550004, 550005, 550006, 550007, 550008, 550009,
    ]);
    const calls = seedCalls();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(String(call.filter)).not.toContain('insight.role');
      expect(call.sort).toEqual(['metrics.thumbsUpCount:desc']);
    }
    expect(insightFallback).toBe(false);
    expect(entries.map((e) => e.versionId)).toEqual([550000, 550001, 550002, 550003, 550004]);
  });

  // The labels still act — through the re-rank, on the popularity pool. Cap 4 -> a pool
  // of 8: 5601 (a confident label for another role and style) is the most popular, the
  // `clothing` + `anime_manga` model 3901 the least popular member. The re-rank moves
  // 3901 to the head and 5601 to the tail, out of the first four: a re-rank that promoted
  // without demoting would return 560100 second.
  const reorderCell = () => {
    const agrees = {
      role: 'clothing',
      styleFamily: 'anime_manga',
      qualityScore: 0.6,
      confidence: 0.9,
    };
    const disagrees = {
      role: 'character',
      styleFamily: 'photorealistic',
      qualityScore: 0.6,
      confidence: 0.9,
    };
    busyCell([], {
      docs: [docOf(3901, 390100, 8930, agrees), docOf(5601, 560100, 9500, disagrees)],
      labels: [
        [390100, agrees],
        [560100, disagrees],
      ],
    });
  };

  it('🔴 the label re-rank still reorders the popularity pool', async () => {
    reorderCell();

    const { entries, insightFallback, promotableVersions } = await findResourceIntentCandidates(
      criteria,
      { browsingLevel: 3, coverage: COVERAGE, cap: 4 }
    );

    // Only 390100 promotes: 560100 demotes and the rest carry no label.
    expect(promotableVersions).toBe(1);
    expect(pooledVersionIds()).toEqual([
      560100, 550000, 550001, 550002, 550003, 550004, 550005, 390100,
    ]);
    expect(insightFallback).toBe(false);
    expect(entries.map((e) => e.versionId)).toEqual([390100, 550000, 550001, 550002]);
  });

  it('control: with the label read failing, the same cell serves the popularity order', async () => {
    reorderCell();
    dbMock.dbRead.resourceInsight.findMany.mockRejectedValue(new Error('label table down'));

    const result = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 4,
    });
    const { entries, insightFallback } = result;

    expect(insightFallback).toBe(true);
    expect(entries.map((e) => e.versionId)).toEqual([560100, 550000, 550001, 550002]);
    expect(result.promotableVersions).toBe(0);
  });

  it('🔴 promotableVersions counts only labels the re-rank PROMOTES — not neutral, not demoted', async () => {
    const label = (role: string, styleFamily: string, confidence: number) => ({
      role,
      styleFamily,
      qualityScore: 0.5,
      confidence,
    });
    const agrees = label('clothing', 'photorealistic', 0.9); // role agrees → promoted
    const belowFloor = label('clothing', 'anime_manga', 0.1); // agrees, under the floor → neutral
    const placeless = label('none', 'other', 0.9); // `none` role, `other` style → neutral
    const disagrees = label('character', 'photorealistic', 0.9); // → demoted
    busyCell([], {
      docs: [
        docOf(3901, 390100, 9600, agrees),
        docOf(3902, 390200, 9590, belowFloor),
        docOf(3903, 390300, 9580, placeless),
        docOf(5601, 560100, 9570, disagrees),
      ],
      labels: [
        [390100, agrees],
        [390200, belowFloor],
        [390300, placeless],
        [560100, disagrees],
      ],
    });

    const { promotableVersions } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 5,
    });

    expect(pooledVersionIds().slice(0, 4)).toEqual([390100, 390200, 390300, 560100]);
    expect(promotableVersions).toBe(1);
  });

  it('promotableVersions counts the POOL, not the returned slice', async () => {
    const agrees = {
      role: 'clothing',
      styleFamily: 'anime_manga',
      qualityScore: 0.5,
      confidence: 0.9,
    };
    busyCell([], {
      docs: [docOf(3901, 390100, 9600, agrees), docOf(3902, 390200, 9590, agrees)],
      labels: [
        [390100, agrees],
        [390200, agrees],
      ],
    });

    // cap 1 -> a pool of 2: both promote, one is returned.
    const { entries, promotableVersions } = await findResourceIntentCandidates(criteria, {
      browsingLevel: 3,
      coverage: COVERAGE,
      cap: 1,
    });

    expect(entries).toHaveLength(1);
    expect(promotableVersions).toBe(2);
  });

  it('🔴 a failing seed page fails the seed', async () => {
    searchWithSignal.mockRejectedValue(new Error('page failed'));

    await expect(
      findResourceIntentCandidates(criteria, { browsingLevel: 3, coverage: COVERAGE, cap: 5 })
    ).rejects.toThrow('page failed');
    expect(seedCalls()).toHaveLength(1);
  });
});
