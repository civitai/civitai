import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as CoocHolder from '~/server/services/resource-intent-cooc/holder';
import type * as JevModule from '~/server/services/ai/jev';

/**
 * SEAM: checkpoint mode's shipped code must produce exactly the lists the offline checkpoint screen
 * produced for the same inputs — ATTACH_BM (the treatment) and BASE_BM (the comparator).
 *
 * The screen's own code is copied below VERBATIM as the oracle (its scripts live outside this
 * repo): the training loop that counts checkpoint attachments per baseModel, `rankCounts`, the gate
 * (`gateEntries`), and the BASE popularity page (`deepList`). Both sides read the same synthetic
 * draw rows and the same synthetic index. Synthetic ids only.
 *
 * The shipped side runs end to end from the draw rows: `CheckpointAttachAccumulator` →
 * `encodeCheckpointAttachSection` → the snapshot payload (`serializeCoocCounts` /
 * `deserializeCoocPayload`) → `decodeCheckpointAttachSection` → `checkpointAttachIndex` → the
 * service → the matcher. Faked: the search client, hydration, redis, ClickHouse and the snapshot
 * holder (it hands over the decoded section). The oracle shares `buildResourceIntentFilter` and
 * `expandOneVersionPerModel` with the shipped side, as the screen did; their own suites own them.
 */

const meiliCalls: { filter?: string; sort?: string[]; limit: number }[] = [];
const searchWithSignal = vi.fn();
const mockGetResourceData = vi.fn();
const holderResolve = vi.fn();
const mockAskJev = vi.fn();

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({}) },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));
vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
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
const { buildResourceIntentFilter, expandOneVersionPerModel } = await import(
  '~/server/services/resource-intent-matcher.service'
);
const { CoocCountAccumulator, deserializeCoocPayload, serializeCoocCounts } = await import(
  '~/server/services/resource-intent-cooc/build'
);
const {
  CheckpointAttachAccumulator,
  checkpointAttachIndex,
  decodeCheckpointAttachSection,
  encodeCheckpointAttachSection,
} = await import('~/server/services/resource-intent-cooc/checkpoint-attach');
const { RESOURCE_INTENT_COOC_SPEC } = await import('~/server/services/resource-intent-cooc/spec');
const { and, inArray } = await import('~/shared/utils/meili-filter');

const BROWSING_LEVEL = 31;
const coverage = { next: false, member: false };
const PROMPT = 'synthetic prompt';
const BM_A = 'SynthA';
const BM_B = 'SynthB';
const BM_EMPTY = 'SynthEmpty';

type DrawRow = {
  imageId: number;
  att: { modelId: number; modelType: string; versionId: number }[];
};
type Doc = {
  id: number;
  name: string;
  type: string;
  metrics: { thumbsUpCount: number };
  versions: { id: number; name: string; baseModel: string; canGenerate: boolean }[];
};

// ─────────────────────────────────────────────────────────────────────────────
// The oracle. Between the two rules: copied verbatim from the screen scripts (then reformatted by
// prettier; no token changed) —
// `rankCounts`, `bump`, `retry` and the `ckptByImage` / `bmPairsOf` / count loop of the training
// phase (ckpt-diagnostic + ckpt-screen-6a), `gateEntries` (6a's run phase) and `deepList` with its
// `once` memo (the diagnostic's run phase). `d` is the one stand-in: it hands those lines the same
// search client, filter builder and expander the shipped side uses; `d.allBrowsingLevelsFlag` is the
// test's browsing level, so both sides send the same filter.
// ─────────────────────────────────────────────────────────────────────────────
const CK = { cap: 50, candTopK: 300, deepLimit: 500 } as const;
const d = {
  searchClient: {
    index: (uid: string) => ({
      uid,
      search: async (_q: string, params: { filter?: string; sort?: string[]; limit: number }) =>
        meili(params),
    }),
  } as {
    index: (uid: string) => { search: (q: string, p: never) => Promise<{ hits: unknown[] }> };
  } | null,
  MODELS_SEARCH_INDEX,
  mf: { and, inArray },
  matcher: { buildResourceIntentFilter, expandOneVersionPerModel },
  allBrowsingLevelsFlag: BROWSING_LEVEL,
};
type Entry = ReturnType<typeof expandOneVersionPerModel>[number];

export function rankCounts(m: ReadonlyMap<number, number> | undefined): number[] {
  if (!m) return [];
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}
function bump<K>(m: Map<K, Map<number, number>>, k: K, id: number) {
  if (!m.has(k)) m.set(k, new Map());
  const x = m.get(k) as Map<number, number>;
  x.set(id, (x.get(id) ?? 0) + 1);
}
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

/** The screen's training-phase counting over the draw, given the versions' baseModels. */
function screenAttachByBm(rows: readonly DrawRow[], vBm: Map<number, string>) {
  const ckptByImage = new Map<number, { modelId: number; versionId: number }[]>();
  for (const r of rows) {
    const ck = r.att
      .filter((a) => a.modelType === 'Checkpoint')
      .map((a) => ({ modelId: a.modelId, versionId: a.versionId }));
    if (ck.length) {
      ckptByImage.set(r.imageId, ck);
    }
  }
  const attachByBm = new Map<string, Map<number, number>>();
  const bmPairsOf = (imageId: number) => {
    const s = new Map<string, [string, number]>();
    for (const x of ckptByImage.get(imageId) ?? []) {
      const bm = vBm.get(x.versionId) ?? '?';
      s.set(`${bm}\u0000${x.modelId}`, [bm, x.modelId]);
    }
    return [...s.values()];
  };
  for (const imageId of ckptByImage.keys())
    for (const [bm, m] of bmPairsOf(imageId)) bump(attachByBm, bm, m);
  return attachByBm;
}

/** The screen's ATTACH_BM and BASE_BM for one request baseModel. */
function screenLists(attachByBm: Map<string, Map<number, number>>) {
  const filterOf = (bm: string | null) =>
    d.matcher.buildResourceIntentFilter({
      modelTypes: ['Checkpoint'],
      baseModels: bm ? [bm] : null,
      browsingLevel: d.allBrowsingLevelsFlag,
      coverage,
    });
  async function gateEntries(cands: readonly number[], bm: string | null): Promise<Entry[]> {
    if (!cands.length) return [];
    const res = await retry(() =>
      d.searchClient!.index(d.MODELS_SEARCH_INDEX).search('', {
        filter: d.mf.and(filterOf(bm), d.mf.inArray('id', [...cands])) ?? undefined,
        limit: cands.length,
      } as never)
    );
    const rank = new Map(cands.map((id, i) => [id, i]));
    const docs = [...(res.hits as never[])].sort(
      (x: { id: number }, y: { id: number }) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9)
    );
    return d.matcher
      .expandOneVersionPerModel(docs, { baseModels: bm ? [bm] : null, coverage, cap: cands.length })
      .slice(0, CK.cap);
  }
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(k: string, f: () => Promise<T>) =>
    (memo.get(k) ?? memo.set(k, f()).get(k)) as Promise<T>;
  const deepList = (bm: string | null) =>
    once(`deep:${bm}`, async () => {
      const res = await retry(() =>
        d.searchClient!.index(d.MODELS_SEARCH_INDEX).search('', {
          filter: filterOf(bm) ?? undefined,
          sort: ['metrics.thumbsUpCount:desc'],
          limit: CK.deepLimit,
        } as never)
      );
      return {
        ids: d.matcher
          .expandOneVersionPerModel(res.hits as never[], {
            baseModels: bm ? [bm] : null,
            coverage,
            cap: CK.deepLimit,
          })
          .map((e) => e.modelId),
        est: (res as { estimatedTotalHits?: number }).estimatedTotalHits ?? null,
        docs: res.hits.length,
      };
    });
  const attachEntries = (bm: string) =>
    once(`attach:${bm}`, () =>
      gateEntries(rankCounts(attachByBm.get(bm)).slice(0, CK.candTopK), bm)
    );
  return {
    ATTACH_BM: async (bm: string) => (await attachEntries(bm)).map((e) => e.modelId),
    // The diagnostic's BASE seam: the 500-doc popularity page's first 50 IS BASE_BM.
    BASE_BM: async (bm: string) => (await deepList(bm)).ids.slice(0, CK.cap),
  };
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The synthetic catalogue: checkpoint model `k` (id 7000 + k) has thumbs `100000 - 7k mod 997`
 * (popularity independent of attachments), 1–3 versions. Model k's version j is under `SynthA` for
 * k < 420, `SynthB` for 420 ≤ k < 440, and model 3's version 2 is under `SynthB` (one model in two
 * ecosystems). Version 0 of models 18 and 41 (ATTACH_BM's head) is not generatable; every 13th
 * model is excluded by the index's maturity clause.
 */
const MODELS = 440;
const versionsOf = (k: number) => (k < 60 ? 3 : 1);
const versionId = (k: number, j: number) => 70_000 + k * 10 + j;
const bmOf = (k: number, j: number) => (k === 3 && j === 2 ? BM_B : k < 420 ? BM_A : BM_B);
const DOCS: Doc[] = Array.from({ length: MODELS }, (_, k) => ({
  id: 7000 + k,
  name: `Synth ckpt ${k}`,
  type: 'Checkpoint',
  metrics: { thumbsUpCount: 100_000 - ((k * 7) % 997) },
  versions: Array.from({ length: versionsOf(k) }, (_, j) => ({
    id: versionId(k, j),
    name: `v${j}`,
    baseModel: bmOf(k, j),
    canGenerate: !(k < 60 && j === 0 && k % 23 === 18),
  })),
})).sort((a, b) => b.metrics.thumbsUpCount - a.metrics.thumbsUpCount || a.id - b.id);
const EXCLUDED = new Set(
  Array.from({ length: MODELS }, (_, k) => 7000 + k).filter((id) => id % 13 === 0)
);

/** Index stand-in: maturity exclusion under the gate's clause, `id IN`; popularity order when sorted. */
function meili(params: { filter?: string; sort?: string[]; limit: number }) {
  meiliCalls.push(params);
  let docs = params.filter?.includes('nsfwLevel IN')
    ? DOCS.filter((x) => !EXCLUDED.has(x.id))
    : DOCS;
  const ids = params.filter?.match(/\bid IN \[([^\]]*)\]/)?.[1];
  if (ids !== undefined) {
    const set = new Set(ids.split(',').map((x) => Number(x.trim())));
    docs = docs.filter((x) => set.has(x.id));
  }
  if (!params.sort) docs = [...docs].reverse();
  return { hits: docs.slice(0, params.limit), estimatedTotalHits: docs.length };
}

/**
 * The synthetic draw. Under SynthA, model k is attached in `1 + (k * 37) % 23` images (many ties,
 * so the id tie-break decides), 400+ models deep so the top-300 cut binds. Some images attach two
 * versions of one model (counted once), two different checkpoints, a LORA beside the checkpoint,
 * or a version the baseModel lookup does not know (counted under '?'); some attach no checkpoint.
 */
function drawRows(): DrawRow[] {
  const rows: DrawRow[] = [];
  let imageId = 1;
  for (let k = 0; k < MODELS; k++) {
    const n = k < 420 ? 1 + ((k * 37) % 23) : 2 + (k % 5);
    for (let i = 0; i < n; i++) {
      const att: DrawRow['att'] = [
        { modelId: 7000 + k, modelType: 'Checkpoint', versionId: versionId(k, i % versionsOf(k)) },
      ];
      if (i % 3 === 1 && versionsOf(k) > 1)
        // A second, different version of the same model (both under SynthA, except model 3's v2).
        att.push({
          modelId: 7000 + k,
          modelType: 'Checkpoint',
          versionId: versionId(k, (i + 1) % versionsOf(k)),
        });
      if (i % 7 === 2) att.push({ modelId: 9000 + i, modelType: 'LORA', versionId: 99_000 + i });
      if (i % 11 === 5)
        att.push({
          modelId: 7000 + ((k + 1) % 420),
          modelType: 'Checkpoint',
          versionId: versionId((k + 1) % 420, 0),
        });
      rows.push({ imageId: imageId++, att });
    }
  }
  rows.push({
    imageId: imageId++,
    att: [{ modelId: 7001, modelType: 'Checkpoint', versionId: 123 }],
  });
  rows.push({ imageId: imageId++, att: [{ modelId: 9100, modelType: 'LORA', versionId: 99_500 }] });
  return rows;
}
const ROWS = drawRows();
const VBM = new Map(
  Array.from({ length: MODELS }, (_, k) =>
    Array.from({ length: versionsOf(k) }, (_, j) => [versionId(k, j), bmOf(k, j)] as const)
  ).flat()
);

/** The shipped build side, from draw rows to the served index, through a real payload round trip. */
async function shippedIndex(rows: readonly DrawRow[]) {
  const acc = new CheckpointAttachAccumulator();
  for (const r of rows) acc.add(r.att);
  // The pipeline looks up exactly the checkpoint versions it saw.
  const asked = acc.versionIds();
  const counts = acc.finalize(
    new Map(asked.filter((v) => VBM.has(v)).map((v) => [v, VBM.get(v)!]))
  );
  const cooc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  cooc.add(['quuxa'], [[1, 'LORA']]);
  const {
    rawPairs: _p,
    rawVocab: _v,
    typeConflicts: _t,
    ...coocCounts
  } = cooc.finalize(RESOURCE_INTENT_COOC_SPEC);
  const payload = await serializeCoocCounts(coocCounts, encodeCheckpointAttachSection(counts));
  const decoded = decodeCheckpointAttachSection(
    (await deserializeCoocPayload(payload)).checkpointSection
  );
  return { asked, counts: decoded.counts, index: checkpointAttachIndex(decoded.counts) };
}

function install(index: Awaited<ReturnType<typeof shippedIndex>>['index'] | null) {
  meiliCalls.length = 0;
  const byVersion = new Map(DOCS.flatMap((x) => x.versions.map((v) => [v.id, x])));
  searchWithSignal.mockImplementation(async (_index, _q, params) => meili(params));
  holderResolve.mockResolvedValue(
    index
      ? {
          snapshot: { contentHash: 'synthetic-snapshot', scores: {}, checkpoints: index },
          fallbackReason: null,
        }
      : { snapshot: null, fallbackReason: 'no_snapshot' }
  );
  mockGetResourceData.mockImplementation(async (ids: number[]) =>
    ids.map((id) => ({
      id,
      name: `v${id}`,
      baseModel: BM_A,
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
        type: 'Checkpoint',
        nsfw: false,
        poi: false,
        userId: 1,
      },
      air: `air:${id}`,
    }))
  );
}

beforeEach(() => {
  searchWithSignal.mockReset();
  mockGetResourceData.mockReset();
  holderResolve.mockReset();
  mockAskJev.mockReset();
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

async function shipped(
  baseModel: string,
  opts: { limit?: number; arm?: 'attach_bm' | 'base_bm' } = {}
) {
  const result = await getResourceIntent(
    { prompt: PROMPT, baseModel, limit: opts.limit, kind: 'checkpoint' },
    { browsingLevel: BROWSING_LEVEL, coverage, checkpointArm: opts.arm }
  );
  expect(result.degraded).toBe(false);
  expect(mockAskJev).not.toHaveBeenCalled();
  return result;
}

/** Shipped, then the oracle; both must send the same search calls (filter + limit, by kind). */
async function bothSides(
  arm: 'ATTACH_BM' | 'BASE_BM',
  baseModel: string,
  opts: { limit?: number; served?: 'attach_bm' | 'base_bm' } = {}
) {
  const result = await shipped(baseModel, { limit: opts.limit, arm: opts.served });
  const shippedCalls = meiliCalls.splice(0);
  const oracle = await screenLists(screenAttachByBm(ROWS, VBM))[arm](baseModel);
  const oracleCalls = meiliCalls.splice(0);
  const byKind = (calls: typeof meiliCalls) =>
    ['sorted', 'unsorted'].map((k) =>
      calls
        .filter((c) => (k === 'sorted') === !!c.sort)
        .map((c) => ({ filter: c.filter, limit: c.limit }))
    );
  expect(byKind(shippedCalls)).toEqual(byKind(oracleCalls));
  return { result, oracle, shippedCalls, ids: result.suggestions.map((s) => s.modelId) };
}

describe('🔴 seam: the build side counts exactly what the screen counted', () => {
  it('per-baseModel attachment counts and the ranked top 300 equal the screen, through a payload round trip', async () => {
    const { asked, counts, index } = await shippedIndex(ROWS);
    const oracle = screenAttachByBm(ROWS, VBM);
    expect(new Set(counts.keys())).toEqual(new Set(oracle.keys()));
    for (const [bm, m] of oracle)
      expect(new Map([...counts.get(bm)!].sort((a, b) => a[0] - b[0]))).toEqual(
        new Map([...m].sort((a, b) => a[0] - b[0]))
      );
    for (const bm of oracle.keys())
      expect(index.candidates.get(bm)).toEqual(rankCounts(oracle.get(bm)).slice(0, CK.candTopK));
    // The fixture reaches every branch it is there for.
    expect(oracle.get('?')).toEqual(new Map([[7001, 1]])); // an unknown version
    expect(oracle.get(BM_B)?.get(7003)).toBeGreaterThan(0); // one model in two ecosystems
    expect(oracle.get(BM_A)!.size).toBeGreaterThan(CK.candTopK); // the top-300 cut binds
    expect(asked).toContain(123);
    expect(asked).not.toContain(99_000 + 2); // LORA versions are never looked up
    // Ties are broken by ascending id: counts repeat every 23 models.
    const ranked = index.candidates.get(BM_A)!;
    const a = oracle.get(BM_A)!;
    expect(ranked.some((id, i) => i > 0 && a.get(id) === a.get(ranked[i - 1]))).toBe(true);
  });
});

describe('🔴 seam: shipped ATTACH_BM = the screen', () => {
  it('SynthA: top 300 by count, gated, re-sorted by count rank, one version per model, first 50', async () => {
    install((await shippedIndex(ROWS)).index);
    const { result, oracle, ids, shippedCalls } = await bothSides('ATTACH_BM', BM_A);
    expect(ids).toEqual(oracle);
    expect(oracle).toHaveLength(50);
    expect(shippedCalls).toHaveLength(1);
    expect(shippedCalls[0].limit).toBe(300);
    expect(shippedCalls[0].filter).toMatch(/nsfwLevel IN .* AND id IN \[/);
    expect(result).toMatchObject({
      kind: 'checkpoint',
      checkpointArm: 'attach_bm',
      coocFallback: false,
    });
    // Pinned as literals too, so the oracle and the service cannot drift TOGETHER.
    expect(oracle.slice(0, 8).map((id) => id - 7000)).toEqual(ATTACH_A_HEAD);
    // A gate-failing version 0 ships its version 1.
    expect(result.suggestions.find((s) => s.modelId === 7018)?.versionId).toBe(versionId(18, 1));
    // An excluded model (id % 13 === 0) with a head-level count never ships.
    expect(ids).not.toContain(7007);
  });

  it.each([10, 30])('SynthA at limit %i: the 50-wide list cut to the limit', async (limit) => {
    install((await shippedIndex(ROWS)).index);
    const { ids, oracle } = await bothSides('ATTACH_BM', BM_A, { limit });
    expect(ids).toEqual(oracle.slice(0, limit));
  });

  it.each([51, 120])(
    'SynthA at limit %i (beyond the screen): exactly the screened 50',
    async (limit) => {
      install((await shippedIndex(ROWS)).index);
      const { ids, oracle } = await bothSides('ATTACH_BM', BM_A, { limit });
      expect(ids).toEqual(oracle);
      expect(ids).toHaveLength(50);
    }
  );

  it('SynthB: a short list (fewer than 50 candidates) is served as the screen had it, unfilled', async () => {
    install((await shippedIndex(ROWS)).index);
    const { ids, oracle } = await bothSides('ATTACH_BM', BM_B);
    expect(ids).toEqual(oracle);
    expect(oracle.length).toBeGreaterThan(5);
    expect(oracle.length).toBeLessThan(50);
    // Model 3 is attached under SynthB through its version 2 only, which is the version served.
    expect(oracle).toContain(7003);
  });

  it('an ecosystem with no attachments in the snapshot: empty, as the screen, and no search', async () => {
    install((await shippedIndex(ROWS)).index);
    const { ids, oracle, shippedCalls } = await bothSides('ATTACH_BM', BM_EMPTY);
    expect(ids).toEqual([]);
    expect(oracle).toEqual([]);
    expect(shippedCalls).toEqual([]);
  });
});

describe('🔴 seam: shipped BASE_BM = the screen', () => {
  it('the base_bm arm is the popularity page, one version per model, first 50', async () => {
    install(null);
    const { ids, oracle, result, shippedCalls } = await bothSides('BASE_BM', BM_A, {
      served: 'base_bm',
    });
    expect(ids).toEqual(oracle);
    expect(oracle).toHaveLength(50);
    expect(shippedCalls.map((c) => c.limit)).toEqual([500]);
    expect(holderResolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'checkpoint', checkpointArm: 'base_bm' });
    expect(result.coocFallback).toBeUndefined();
    expect(oracle.slice(0, 6).map((id) => id - 7000)).toEqual(BASE_A_HEAD);
  });

  it('base_bm at limit 10 is the prefix', async () => {
    install(null);
    const { ids, oracle } = await bothSides('BASE_BM', BM_A, { served: 'base_bm', limit: 10 });
    expect(ids).toEqual(oracle.slice(0, 10));
  });

  it('attach_bm with no servable snapshot serves BASE_BM, flagged', async () => {
    install(null);
    const { ids, oracle, result } = await bothSides('BASE_BM', BM_A);
    expect(ids).toEqual(oracle);
    expect(result).toMatchObject({ checkpointArm: 'attach_bm', coocFallback: true });
  });

  it('the two arms differ on this fixture (the comparison is not vacuous)', async () => {
    const attach = await screenLists(screenAttachByBm(ROWS, VBM)).ATTACH_BM(BM_A);
    const base = await screenLists(screenAttachByBm(ROWS, VBM)).BASE_BM(BM_A);
    expect(attach.slice(0, 10)).not.toEqual(base.slice(0, 10));
  });
});

// Literal heads (model id − 7000), from the oracle on this fixture.
const ATTACH_A_HEAD = [18, 41, 64, 87, 110, 133, 156, 179];
const BASE_A_HEAD = [0, 285, 143, 1, 286, 144];
