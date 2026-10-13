import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setEnv } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type { JevChoiceQuestion } from '~/server/services/ai/jev';
import type { ResourceIntentShortlistEntry } from '~/server/services/resource-intent-matcher.service';

/**
 * SEAM: the shipped HYBRID_10 path must produce exactly the order the offline arm screen
 * produced for the same inputs. The screen's own functions are copied below VERBATIM as
 * the oracle (its script lives outside this repo), and both sides read the same synthetic
 * index, the same labels and the same recorded stage-3 answers.
 *
 * Only the vendor's HTTP (`fetch`), the search client, the label table, hydration and
 * redis are faked. `askJev`'s wire build and parse, the matcher (seed, label re-rank,
 * BASE pool) and the service run for real — the surfaces the unit suites each fake.
 */

const searchWithSignal = vi.fn();
const mockGetResourceData = vi.fn();
const fetchMock = vi.fn();

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({}) },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));
// Hand-listed for the same reason resource-intent.service.test.ts hand-lists it.
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const { getResourceIntent } = await import('~/server/services/resource-intent.service');
const { expandShortlist, findResourceIntentCandidates } = await import(
  '~/server/services/resource-intent-matcher.service'
);

const BASE_MODEL = 'Illustrious';
const COVERAGE = { next: false, member: false };
const CAP = 50;
const POOL_CAP = 100;
const PROMPT = 'synthetic prompt for the seam fixture';

type Doc = {
  id: number;
  name: string;
  type: string;
  metrics: { thumbsUpCount: number };
  versions: { id: number; name: string; baseModel: string; canGenerate: boolean }[];
};

/** A popularity-ordered corpus: model k has `versions(k)` versions, `passes` decides its gate. */
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

/** Recorded-format label rows: version → (role, confidence). */
type Label = { modelVersionId: number; role: string; confidence: number };

/**
 * The recorded stage-3 behaviour: each listed version's affinity, weighted toward the
 * first-listed options (the primacy bias that is the reason for two orders), plus a fixed
 * `none` mass; normalised. A pure function of what was LISTED, so both sides get the same
 * answer for the same question.
 */
function recordedDistribution(
  criteria: Record<string, string>,
  affinity: Record<string, number>
): Record<string, number> {
  const raw: Record<string, number> = { none: 0.4 };
  for (const [option, description] of Object.entries(criteria)) {
    if (option === 'none') continue;
    const a = affinity[description] ?? 0;
    if (a > 0) raw[option] = a * (1 + 1 / (Number(option) + 1));
  }
  const total = Object.values(raw).reduce((s, p) => s + p, 0);
  return Object.fromEntries(Object.entries(raw).map(([k, p]) => [k, p / total]));
}
const argmax = (d: Record<string, number>) => Object.entries(d).sort((a, b) => b[1] - a[1])[0][0];

type Row = {
  docs: Doc[];
  labels: Label[];
  /** By the description the option carries on the wire. */
  affinity: Record<string, number>;
};

function install(row: Row) {
  const byVersion = new Map(row.docs.flatMap((d) => d.versions.map((v) => [v.id, d])));
  searchWithSignal.mockImplementation(async (_index, _q, params: { limit: number }) => ({
    hits: row.docs.slice(0, params.limit),
    estimatedTotalHits: row.docs.length,
  }));
  dbMock.dbRead.resourceInsight.findMany.mockImplementation(
    async ({ where }: { where: { modelVersionId: { in: number[] } } }) =>
      row.labels
        .filter((l) => where.modelVersionId.in.includes(l.modelVersionId))
        .map((l) => ({ ...l, styleFamily: 'other', qualityScore: 0.5 }))
  );
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
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as {
      questions: Record<string, { instructions: string; criteria?: Record<string, string> }>;
    };
    const stage3 = body.questions.resourceVersion;
    const answers = stage3
      ? (() => {
          const probabilities = recordedDistribution(stage3.criteria!, row.affinity);
          return {
            resourceVersion: {
              type: 'choice',
              choice: argmax(probabilities),
              probabilities,
              confidence: 0.4,
            },
          };
        })()
      : STAGE1_ANSWERS;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'typesafe/jev-1.13-20260917',
          answers,
          usage: { input_tokens: 300, output_tokens: 40, cost: 5.5e-5 },
        }),
    };
  });
}

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
const CRITERIA = {
  criteriaVersion: 2 as const,
  specHash: 'seam',
  role: 'character' as const,
  styleFamily: 'anime_manga' as const,
  modelTypes: ['LORA', 'TextualInversion', 'LoCon', 'DoRA'] as never,
  baseModel: BASE_MODEL,
};

// ─────────────────────────────────────────────────────────────────────────────
// The oracle. Everything between the two rules is copied verbatim (minus `export` and one stale line comment) from
// the screen script (R4c block, combineR4c, runR4c, mergeHybrid); `askStage3` is the one stand-in,
// replaying the recorded answers instead of calling the vendor.
// ─────────────────────────────────────────────────────────────────────────────
type Bucket = 'R4C_SHIPPED';
let oracleAffinity: Record<string, number> = {};
async function askStage3(
  _bucket: Bucket,
  _state: Record<string, string>,
  question: JevChoiceQuestion
) {
  const criteria = Object.fromEntries(
    question.options.map((o) => [o, question.optionDescriptions?.[o] ?? o])
  );
  const distribution = recordedDistribution(criteria, oracleAffinity);
  return { type: 'choice' as const, value: argmax(distribution), distribution };
}

const R4C_INSTRUCTIONS =
  'The `prompt` is an image-generation prompt. `role` is the kind of add-on resource it needs and `styleFamily` is its visual style family. Which ONE of the listed community resources best fits this prompt for that role? Choose "none" if no listed resource fits.';
const R4C_NONE_DESCRIPTION =
  'None of the listed resources fits: each is the wrong character, subject, style or purpose for this prompt.';
function describeEntry(e: ResourceIntentShortlistEntry): string {
  return `${e.modelName} — ${e.versionName} (${e.modelType}, ${e.baseModel})`;
}
/** Positional keys "0".."n-1" for the order sent, plus a described `none`. */
function buildR4cQuestion(ordered: ResourceIntentShortlistEntry[]): JevChoiceQuestion {
  const options = [...ordered.map((_, i) => String(i)), 'none'];
  const optionDescriptions: Record<string, string> = { none: R4C_NONE_DESCRIPTION };
  ordered.forEach((e, i) => (optionDescriptions[String(i)] = describeEntry(e)));
  return {
    id: 'resourceVersion',
    type: 'choice',
    prompt: R4C_INSTRUCTIONS,
    options,
    optionDescriptions,
  };
}

function combineR4c(
  n: number,
  orders: number[][],
  dists: Record<string, number>[],
  values: string[]
) {
  const avg = new Map<number, number>(); // shortlist index -> summed p
  let noneSum = 0;
  const tops: (number | 'none')[] = [];
  orders.forEach((order, oi) => {
    const d = dists[oi];
    order.forEach((idx, k) => avg.set(idx, (avg.get(idx) ?? 0) + (d[String(k)] ?? 0)));
    noneSum += d['none'] ?? 0;
    tops.push(values[oi] === 'none' ? 'none' : order[Number(values[oi])]);
  });
  const m = orders.length;
  const orderIdx = Array.from({ length: n }, (_, i) => ({ i, p: (avg.get(i) ?? 0) / m }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x) => x.i);
  const maxCand = Math.max(0, ...[...avg.values()].map((v) => v / m));
  return {
    orderIdx,
    noneP: noneSum / m,
    noneArgmax: noneSum / m > maxCand,
    ordersAgreeTop: tops[0] === tops[1],
    nonzero: [...avg.values()].filter((v) => v > 0).length,
  };
}

async function runR4c(
  bucket: Bucket,
  shortlist: ResourceIntentShortlistEntry[],
  popRank: (i: number) => number,
  state: Record<string, string>
) {
  const popOrder = shortlist
    .map((e, i) => ({ e, i, p: popRank(i) }))
    .sort((a, b) => a.p - b.p || a.i - b.i);
  const revOrder = [...popOrder].reverse();
  const orders = [popOrder, revOrder];
  const dists: Record<string, number>[] = [];
  const values: string[] = [];
  for (const order of orders) {
    const a = await askStage3(bucket, state, buildR4cQuestion(order.map((o) => o.e)));
    dists.push(a.distribution);
    values.push(a.value);
  }
  const c = combineR4c(
    shortlist.length,
    orders.map((o) => o.map((x) => x.i)),
    dists,
    values
  );
  return { ...c, ordered: c.orderIdx.map((i) => shortlist[i]) };
}

function mergeHybrid(
  head: readonly number[],
  fill: readonly number[],
  headSize: number,
  cap: number
): number[] {
  const out: number[] = [];
  const placed = new Set<number>();
  for (const id of head) {
    if (out.length >= headSize) break;
    if (placed.has(id)) continue;
    placed.add(id);
    out.push(id);
  }
  for (const id of fill) {
    if (out.length >= cap) break;
    if (placed.has(id)) continue;
    placed.add(id);
    out.push(id);
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
// ─────────────────────────────────────────────────────────────────────────────

/** The screen's per-row HYBRID_10 computation, minus scoring (its processRow, trimmed). */
async function screenHybrid10(row: Row): Promise<number[]> {
  oracleAffinity = row.affinity;
  const baseModels = [BASE_MODEL];
  const shipped = await findResourceIntentCandidates(CRITERIA, {
    browsingLevel: 31,
    coverage: COVERAGE,
    cap: CAP,
  });
  const deep = row.docs.slice(0, 500);
  const r3Pool: ResourceIntentShortlistEntry[] = [];
  for (const doc of deep) {
    if (r3Pool.length >= POOL_CAP) break;
    const one = expandShortlist([doc as never], { baseModels, coverage: COVERAGE, cap: 1 });
    if (one.length) r3Pool.push(one[0]);
  }
  const basePool = r3Pool.map((e) => e.modelId);
  const shortlist = shipped.entries;
  const state = { prompt: PROMPT, role: CRITERIA.role, styleFamily: CRITERIA.styleFamily };
  let r4cList: number[] = [];
  if (shortlist.length) {
    const poolIdx = new Map(shipped.pool.map((e, i) => [e.versionId, i]));
    const pr = (i: number) => poolIdx.get(shortlist[i].versionId) ?? Number.MAX_SAFE_INTEGER;
    const x = await runR4c('R4C_SHIPPED', shortlist, pr, state);
    r4cList = rankedModelIds(x.ordered);
  }
  return mergeHybrid(r4cList, basePool, 10, CAP);
}

const describe_ = (k: number, j: number) => `Synth ${k} — v${j} (LORA, ${BASE_MODEL})`;

/**
 * Row A — the common shape. 160 models; the first 30 carry 3 versions (version 0 fails
 * the base-model gate on every 4th), every 9th model fails entirely. Labels promote two
 * mid-pool models and demote the most popular one. Stage 3 likes two versions of one
 * model (the dedupe case), a promoted model, and a few others.
 */
const ROW_A: Row = {
  docs: corpus(
    160,
    (k) => (k < 30 ? 3 : 1),
    (k, j) => k % 9 !== 8 && !(k < 30 && j === 0 && k % 4 === 0)
  ),
  labels: [
    { modelVersionId: 50_000 + 31 * 10, role: 'character', confidence: 0.9 },
    { modelVersionId: 50_000 + 34 * 10, role: 'character', confidence: 0.9 },
    { modelVersionId: 50_000 + 0 * 10 + 1, role: 'style', confidence: 0.9 },
  ],
  affinity: {
    [describe_(3, 1)]: 0.5,
    [describe_(3, 2)]: 0.45,
    [describe_(34, 0)]: 0.4,
    [describe_(12, 2)]: 0.2,
    [describe_(1, 0)]: 0.1,
    [describe_(25, 1)]: 0.05,
  },
};

/** Row B — the seed page holds only 20 gate-passing models, so BASE's fill comes from deeper. */
const ROW_B: Row = {
  docs: corpus(
    600,
    () => 2,
    (k, j) => k % 5 === 0 && j === 1
  ),
  labels: [],
  affinity: { [describe_(40, 1)]: 0.6, [describe_(5, 1)]: 0.3 },
};

/** Row C — nothing in the seed page passes: empty shortlist, so BASE's top 50 alone. */
const ROW_C: Row = {
  docs: corpus(
    300,
    () => 1,
    (k) => k >= 120
  ),
  labels: [],
  affinity: {},
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' });
  searchWithSignal.mockReset();
  mockGetResourceData.mockReset();
  dbMock.dbRead.resourceInsight.findMany.mockReset();
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

async function shipped(row: Row) {
  install(row);
  const result = await getResourceIntent(
    { prompt: PROMPT, baseModel: BASE_MODEL },
    { browsingLevel: 31, coverage: COVERAGE }
  );
  expect(result.degraded).toBe(false);
  // One path for every row: the seed page, then BASE's own 500-document page.
  expect(searchWithSignal.mock.calls.map((c) => (c[2] as { limit: number }).limit)).toEqual([
    100, 500,
  ]);
  return result;
}

describe('🔴 seam: shipped HYBRID_10 = the screen, row by row', () => {
  it('row A: label re-rank + R4c head (with a two-version model) + BASE fill', async () => {
    const result = await shipped(ROW_A);
    const fetched = fetchMock.mock.calls.length;
    const oracle = await screenHybrid10(ROW_A);

    expect(fetched).toBe(3); // stage 1 + two stage-3 calls
    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle);
    // Pinned as literals too, so the oracle and the service cannot drift TOGETHER. Model 34
    // (label-promoted, last in popularity) beats model 3's top version only through the
    // REVERSE call's primacy; model 3's second version is skipped; model 25 is outside
    // the 50-version shortlist; then the shortlist (re-rank) order fills the head.
    expect(oracle.slice(0, 10).map((id) => id - 5000)).toEqual([34, 3, 12, 1, 31, 0, 2, 4, 5, 6]);
    expect(oracle.slice(10).map((id) => id - 5000)).toEqual(ROW_A_FILL);
    expect(oracle).toHaveLength(50);
  });

  it('row B: BASE reaches past the seed page when few models pass the gate', async () => {
    const result = await shipped(ROW_B);
    const oracle = await screenHybrid10(ROW_B);

    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle);
    expect(oracle.slice(0, 3).map((id) => id - 5000)).toEqual([40, 5, 0]);
    expect(oracle).toHaveLength(50);
    expect(oracle.at(-1)! - 5000).toBe(245);
  });

  it('row C: an empty shortlist returns BASE top 50 and asks stage 3 nothing', async () => {
    const result = await shipped(ROW_C);
    const fetched = fetchMock.mock.calls.length;
    const oracle = await screenHybrid10(ROW_C);

    expect(fetched).toBe(1);
    expect(result.noneProbability).toBe(0.1); // stage 1's role.none: stage 3 never ran
    expect(result.suggestions.map((s) => s.modelId)).toEqual(oracle);
    expect(oracle.map((id) => id - 5000)).toEqual(Array.from({ length: 50 }, (_, i) => 120 + i));
  });
});

// BASE order (every model with a gate-passing version) minus the head, 40 deep.
const ROW_A_FILL = [
  7, 9, 10, 11, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 32, 33, 36, 37, 38,
  39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50, 51, 52, 54, 55,
];
