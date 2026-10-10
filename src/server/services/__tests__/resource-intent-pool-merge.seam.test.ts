import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setEnv } from '~/__tests__/mocks';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import type * as MeiliClient from '~/server/meilisearch/client';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as CoocHolder from '~/server/services/resource-intent-cooc/holder';
import type { ResourceIntentShortlistEntry } from '~/server/services/resource-intent-matcher.service';

/**
 * SEAM: the shipped POOL_MERGE path must produce exactly the list the offline co-occurrence
 * screen produced for the same inputs. The screen's own gate and merge code is copied below
 * VERBATIM as the oracle (its script lives outside this repo); both sides read the same synthetic
 * index, the same synthetic snapshot and the same candidates.
 *
 * Faked: the vendor's HTTP (`fetch`, stage 1 only), the search client, hydration, redis and the
 * snapshot holder (it hands over a snapshot scored from synthetic counts). `askJev`, the
 * tokenizer, `rankCooc`, the matcher and the service run for real. Synthetic ids only.
 */

const meiliCalls: { filter?: string; sort?: string[]; limit: number }[] = [];
const searchWithSignal = vi.fn();
const mockGetResourceData = vi.fn();
const fetchMock = vi.fn();
const holderResolve = vi.fn();

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({}) },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));
vi.mock('~/server/services/resource-intent-cooc/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof CoocHolder>()),
  coocSnapshotHolder: () => ({ resolve: holderResolve }),
}));

const { getResourceIntent } = await import('~/server/services/resource-intent.service');
const { buildResourceIntentFilter, expandOneVersionPerModel, expandShortlist } = await import(
  '~/server/services/resource-intent-matcher.service'
);
const { CoocCountAccumulator } = await import('~/server/services/resource-intent-cooc/build');
const { loadScores, rankCooc } = await import('~/server/services/resource-intent-cooc/score');
const { RESOURCE_INTENT_COOC_SPEC } = await import('~/server/services/resource-intent-cooc/spec');
const { coocQueryTokens } = await import('~/server/services/resource-intent-cooc/tokenize');
const { and, inArray } = await import('~/shared/utils/meili-filter');

const BASE_MODEL = 'Illustrious';
const COVERAGE = { next: false, member: false };
const PROMPT = 'zephyr yarrow synthetic portrait';
const CRITERIA_TYPES = ['LORA', 'TextualInversion', 'LoCon', 'DoRA'] as never;

type Doc = {
  id: number;
  name: string;
  type: string;
  metrics: { thumbsUpCount: number };
  versions: { id: number; name: string; baseModel: string; canGenerate: boolean }[];
};
type Row = {
  docs: Doc[];
  /** Ids the index filter excludes (as a maturity or celebrity clause would). */
  excluded: Set<number>;
  scores: ReturnType<typeof loadScores>;
};

/** A popularity-ordered corpus: model k has `versionCount(k)` versions, `passes` decides each one's gate. */
function corpus(
  size: number,
  versionCount: (k: number) => number,
  passes: (k: number, j: number) => boolean
): Doc[] {
  return Array.from({ length: size }, (_, k) => ({
    id: 5000 + k,
    name: `Synth ${k}`,
    type: 'LORA',
    metrics: { thumbsUpCount: 100_000 - k },
    versions: Array.from({ length: versionCount(k) }, (_, j) => ({
      id: 50_000 + k * 10 + j,
      name: `v${j}`,
      baseModel: passes(k, j) ? BASE_MODEL : 'Pony',
      canGenerate: true,
    })),
  }));
}

/**
 * Synthetic training rows: `zephyr` rows attach `zephyrModels[j]` in `60 - j` rows and `yarrow` rows
 * attach `yarrowModels[j]` in `30 - j` rows; every model also appears in a few rows of its own so
 * `n_m` varies; filler rows keep both tokens under the spec's document-frequency ceiling.
 */
function snapshotScores(zephyrModels: number[], yarrowModels: number[]) {
  const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  const block = (token: string, models: number[], rows: number) => {
    for (let i = 0; i < rows; i++) {
      acc.add(
        [token, 'quuxa'],
        models.filter((_, j) => i < rows - j).map((m) => [m, 'LORA'] as const)
      );
    }
  };
  block('zephyr', zephyrModels, 60);
  block('yarrow', yarrowModels, 30);
  [...zephyrModels, ...yarrowModels].forEach((m, j) => {
    for (let r = 0; r < (j * 7) % 13; r++) acc.add(['ambient'], [[m, 'LORA']]);
  });
  for (let i = 0; i < 3000; i++) acc.add([], []);
  const {
    rawPairs: _p,
    rawVocab: _v,
    typeConflicts: _t,
    ...counts
  } = acc.finalize(RESOURCE_INTENT_COOC_SPEC);
  return loadScores(counts, { beta: RESOURCE_INTENT_COOC_SPEC.beta });
}

let row: Row;

/** The index: filtered by `excluded` and `id IN`, popularity order when sorted, reversed when not. */
function meili(params: { filter?: string; sort?: string[]; limit: number }) {
  meiliCalls.push(params);
  let docs = row.docs.filter((d) => !row.excluded.has(d.id));
  const ids = params.filter?.match(/\bid IN \[([^\]]*)\]/)?.[1];
  if (ids !== undefined) {
    const set = new Set(ids.split(',').map((x) => Number(x.trim())));
    docs = docs.filter((d) => set.has(d.id));
  }
  if (!params.sort) docs = [...docs].reverse();
  return { hits: docs.slice(0, params.limit), estimatedTotalHits: docs.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// The oracle. Between the two rules: copied verbatim from the screen script (`retry`,
// `deepPage`, `distinct`, `mergeReservedK`, `rankedModelIds` and the BASE / COOC blocks of its
// row loop). `searchClient` is the one stand-in, answering from the same index as the shipped
// side.
// ─────────────────────────────────────────────────────────────────────────────
const searchClient = {
  index: (uid: string) => ({
    uid,
    search: async <T>(_q: string, params: { filter?: string; sort?: string[]; limit: number }) =>
      meili(params) as unknown as { hits: T[] },
  }),
};
const DEEP_LIMIT = 500;
const SORT = ['metrics.thumbsUpCount:desc'];
const CAP = 50;
const POOL_CAP = 100;
const COOC_SLOTS = 25;

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

async function deepPage(filter: string | null) {
  const client = searchClient!;
  return retry(() =>
    client.index(MODELS_SEARCH_INDEX).search<ModelSearchIndexRecord>('', {
      filter: filter ?? undefined,
      sort: SORT,
      limit: DEEP_LIMIT,
    })
  );
}
function distinct(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}
function mergeReservedK(
  a: readonly number[],
  base: readonly number[],
  slots: number,
  cap: number
): number[] {
  const R = distinct(a).slice(0, slots);
  const inR = new Set(R);
  const B = distinct(base)
    .filter((id) => !inR.has(id))
    .slice(0, cap - R.length);
  const out: number[] = [];
  for (let i = 0; out.length < R.length + B.length; i++) {
    if (i < R.length) out.push(R[i]);
    if (i < B.length) out.push(B[i]);
  }
  return out;
}
// `rankedModelIds` from scripts/eval-resource-intent-retrieval.ts, verbatim.
function rankedModelIds(entries: readonly Pick<ResourceIntentShortlistEntry, 'modelId'>[]) {
  const seen = new Set<number>();
  const ranked: number[] = [];
  for (const entry of entries) {
    if (seen.has(entry.modelId)) continue;
    seen.add(entry.modelId);
    ranked.push(entry.modelId);
  }
  return ranked;
}

/** The screen's per-row POOL_MERGE computation, minus scoring (its processRow, trimmed). */
async function screenPoolMerge(noSnapshot = false): Promise<number[]> {
  const baseModels = [BASE_MODEL];
  const coverage = COVERAGE;
  const filter = buildResourceIntentFilter({
    modelTypes: CRITERIA_TYPES,
    baseModels,
    browsingLevel: 31,
    coverage,
  });
  // The candidates: the shipped scorer on the row's snapshot, as the private replay drove it.
  const cands = noSnapshot
    ? []
    : rankCooc(
        row.scores,
        coocQueryTokens(PROMPT),
        CRITERIA_TYPES,
        RESOURCE_INTENT_COOC_SPEC.topK
      ).map((c) => c.modelId);

  // BASE rebuilt now (rank 2 / 2c's loop verbatim).
  const deep = (await deepPage(filter)).hits;
  const r3Pool: ResourceIntentShortlistEntry[] = [];
  for (const doc of deep) {
    if (r3Pool.length >= POOL_CAP) break;
    const one = expandShortlist([doc], { baseModels, coverage, cap: 1 });
    if (one.length) r3Pool.push(one[0]);
  }
  const basePool = r3Pool.map((e) => e.modelId);
  // The production function on the same page gives the same pool (gate reproduction, BASE side).
  expect(
    expandOneVersionPerModel(deep, { baseModels, coverage, cap: POOL_CAP })
      .map((e) => e.versionId)
      .join(',')
  ).toBe(r3Pool.map((e) => e.versionId).join(','));

  const candRank = new Map(cands.map((id, i) => [id, i]));
  let gatedAll: ResourceIntentShortlistEntry[] = [];
  if (cands.length) {
    const res = await retry(() =>
      searchClient!.index(MODELS_SEARCH_INDEX).search<ModelSearchIndexRecord>('', {
        filter: and(filter, inArray('id', cands)) ?? undefined,
        limit: cands.length,
      })
    );
    const docs = [...res.hits].sort(
      (x, y) => (candRank.get(x.id) ?? 1e9) - (candRank.get(y.id) ?? 1e9)
    );
    gatedAll = expandOneVersionPerModel(docs, { baseModels, coverage, cap: cands.length });
  }
  const coocEntries = gatedAll.slice(0, CAP);
  const coocList = rankedModelIds(coocEntries);

  const poolMerge = mergeReservedK(coocList, basePool, COOC_SLOTS, CAP);
  return poolMerge;
}
// ─────────────────────────────────────────────────────────────────────────────

const STAGE1_ANSWERS = {
  needsResource: { type: 'noul', noul: 0.8 },
  role: {
    type: 'choice',
    choice: 'character',
    probabilities: { character: 0.7, style: 0.2, none: 0.1 },
    confidence: 0.5,
  },
  styleFamily: {
    type: 'choice',
    choice: 'anime_manga',
    probabilities: { anime_manga: 0.9, other: 0.1 },
    confidence: 0.6,
  },
  contentType: {
    type: 'choice',
    choice: 'portrait_character',
    probabilities: { portrait_character: 1 },
    confidence: 0.9,
  },
  specificity: { type: 'score', score: 2, probabilities: { '2': 1 }, confidence: 0.5 },
  injectionPresent: { type: 'noul', noul: 0.01 },
};

function install(r: Row) {
  row = r;
  meiliCalls.length = 0;
  const byVersion = new Map(r.docs.flatMap((d) => d.versions.map((v) => [v.id, d])));
  searchWithSignal.mockImplementation(async (_index, _q, params) => meili(params));
  holderResolve.mockResolvedValue({
    snapshot: { contentHash: 'synthetic-snapshot', scores: r.scores },
    fallbackReason: null,
  });
  mockGetResourceData.mockImplementation(async (ids: number[]) =>
    ids.map((id) => ({
      id,
      name: `v${id}`,
      baseModel: BASE_MODEL,
      strength: 1,
      minStrength: -1,
      maxStrength: 2,
      trainedWords: [],
      clipSkip: null,
      hasAccess: true,
      canGenerate: true,
      model: {
        id: byVersion.get(id)!.id,
        name: 'm',
        type: 'LORA',
        nsfw: false,
        poi: false,
        userId: 1,
      },
      air: `air:${id}`,
    }))
  );
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        model: 'typesafe/jev-1.13-20260917',
        answers: STAGE1_ANSWERS,
        usage: { input_tokens: 300, output_tokens: 40, cost: 5.5e-5 },
      }),
  }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' });
  searchWithSignal.mockReset();
  mockGetResourceData.mockReset();
  holderResolve.mockReset();
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

async function shipped(limit?: number, coocFallback = false) {
  const result = await getResourceIntent(
    { prompt: PROMPT, baseModel: BASE_MODEL, limit },
    { browsingLevel: 31, coverage: COVERAGE, poolMerge: true }
  );
  expect(result.degraded).toBe(false);
  expect(result.coocFallback).toBe(coocFallback);
  expect(fetchMock).toHaveBeenCalledTimes(1); // stage 1 only: no stage 3 on this arm
  return result;
}

const ids = (k: number[]) => k.map((x) => 5000 + x);

/**
 * Row A — 40 + 20 co-occurrence models spread through a 600-model corpus, so some sit inside
 * BASE's 100 and most deeper. Every 11th model is excluded by the index filter; the first 30
 * models carry 3 versions, version 0 failing the base-model gate on every 4th; every 9th model
 * fails entirely.
 */
const ROW_A_ZEPHYR = ids(Array.from({ length: 40 }, (_, j) => (j * 37 + 3) % 600));
const ROW_A_YARROW = ids(Array.from({ length: 20 }, (_, j) => (j * 53 + 11) % 600));
const rowA = (): Row => ({
  docs: corpus(
    600,
    (k) => (k < 30 ? 3 : 1),
    (k, j) => k % 9 !== 8 && !(k < 30 && j === 0 && k % 4 === 0)
  ),
  excluded: new Set(ids(Array.from({ length: 55 }, (_, i) => i * 11 + 10))),
  scores: snapshotScores(ROW_A_ZEPHYR, ROW_A_YARROW),
});

/** Row B — only three co-occurrence models, one of them also BASE's most popular. */
const rowB = (): Row => ({
  docs: corpus(
    300,
    () => 1,
    () => true
  ),
  excluded: new Set(),
  scores: snapshotScores(ids([0, 250, 120]), []),
});

/** Row C — the snapshot knows none of the prompt's tokens: no candidates, BASE alone. */
const rowC = (): Row => ({
  docs: corpus(
    300,
    () => 1,
    (k) => k % 3 !== 0
  ),
  excluded: new Set(),
  scores: (() => {
    const s = snapshotScores(ids([1, 2]), []);
    return { ...s, vocabIndex: new Map() };
  })(),
});

describe('🔴 seam: shipped POOL_MERGE = the screen, row by row', () => {
  it('row A: 25 reserved co-occurrence models interleaved with BASE, gates and re-sort applied', async () => {
    install(rowA());
    const result = await shipped();
    const shippedCalls = [...meiliCalls];
    const oracle = await screenPoolMerge();

    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle);
    expect(oracle).toHaveLength(50);
    // The co-occurrence query is the screen's: no sort, one page as wide as the candidates.
    const cooc = shippedCalls.find((c) => !c.sort)!;
    expect(cooc.limit).toBe(59); // 60 synthetic models, one on both token lists
    expect(shippedCalls.map((c) => c.limit).sort((a, b) => a - b)).toEqual([59, 500]);
    // Pinned as literals too, so the oracle and the service cannot drift TOGETHER.
    expect(oracle.slice(0, 10).map((id) => id - 5000)).toEqual(ROW_A_HEAD);
    // A three-version model whose version 0 fails the gate ships its version 1.
    const m12 = result.suggestions.find((s) => s.modelId === 5012);
    expect(m12?.versionId).toBe(50_121);
  });

  it('row B: a short co-occurrence list leaves its unused slots to BASE', async () => {
    install(rowB());
    const result = await shipped();
    const oracle = await screenPoolMerge();

    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle);
    expect(oracle.slice(0, 7).map((id) => id - 5000)).toEqual([0, 1, 120, 2, 250, 3, 4]);
    expect(oracle).toHaveLength(50);
  });

  it('row C: no candidates — BASE top 50, and no co-occurrence query', async () => {
    install(rowC());
    const result = await shipped();
    const shippedLimits = meiliCalls.map((c) => c.limit);
    const oracle = await screenPoolMerge();

    expect(shippedLimits).toEqual([500]);
    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle);
    expect(oracle.slice(0, 4).map((id) => id - 5000)).toEqual([1, 2, 4, 5]);
  });

  it('row A with no servable snapshot: BASE top 50 through the same gates, flagged', async () => {
    install(rowA());
    holderResolve.mockResolvedValue({ snapshot: null, fallbackReason: 'no_snapshot' });
    const result = await shipped(undefined, true);
    const shippedLimits = meiliCalls.map((c) => c.limit);
    const oracle = await screenPoolMerge(true);

    expect(shippedLimits).toEqual([500]);
    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle);
    expect(oracle).toHaveLength(50);
    // Excluded (10, 21) and gate-failing (8, 17) models are skipped.
    expect(oracle.slice(0, 10).map((id) => id - 5000)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9, 11]);
  });

  it('row A at limit 10: the 50-wide list cut to 10', async () => {
    install(rowA());
    const result = await shipped(10);
    const oracle = await screenPoolMerge();

    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle.slice(0, 10));
  });
});

// Model 365 is on both token lists, so it scores highest; model 3 is reserved, so BASE skips it.
const ROW_A_HEAD = [365, 0, 47, 1, 64, 2, 276, 4, 259, 5];
