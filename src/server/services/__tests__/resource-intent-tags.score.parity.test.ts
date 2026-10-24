import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { SparseByKey, TagIndexData } from '~/server/services/resource-intent-tags/build';
import type { TagKind } from '~/server/services/resource-intent-tags/score';
import { compareCodePoints } from '~/server/services/resource-intent-tags/extract';
import {
  decodeTagIndex,
  encodeTagIndex,
  tagIndexFromData,
} from '~/server/services/resource-intent-tags/payload';
import {
  resolveEcosystems,
  scoreTagRequest,
  TAG_SCORE_PARAMS,
} from '~/server/services/resource-intent-tags/score';

/**
 * Parity: the scorer against the offline prototype's own output (V1 score, LEX request side, the
 * tag-derived ecosystem resolver) on a SYNTHETIC index: invented tag keys, ecosystems and model ids.
 * The generator built the index in the prototype's own data structures, ran the prototype's functions
 * on these requests and wrote what they returned; it also exported the index in the shape below. It
 * imports non-public code and is not in this repository. Never edit the fixture to make this pass;
 * regenerate it or fix the port. The index is this fixture in the build's output shape, validated by
 * `tagIndexFromData` as built (float64, every value to 12 decimals) and also encoded into the snapshot
 * and decoded by the production decoder (float32: candidate scores to 1e-7, absolute below 1 and
 * relative above, the ranked order exactly).
 */
type Pairs = [number, number][];
type KindJson = {
  modelIds: number[];
  fit: number[];
  ecosystems: string[][];
  postings: Record<string, [number, number, number | null][]>;
  ecosystemUsers: Record<string, Pairs>;
  userByTag: Record<string, Pairs>;
  userByEcosystem: Record<string, Pairs>;
};
type Case = {
  name: string;
  prompt: string;
  browsingLevel: number;
  baseModel: string | null;
  kind: TagKind;
  found: string[];
  keptWeights: [string, number][];
  noTags?: true;
  ecosystems?: string[];
  ecosystem?: string;
  candidateCount?: number;
  ranked?: Pairs;
  resolver?: [string, number][];
};
type Golden = {
  vocabulary: { key: string; idf: number; explicit: boolean; near: number[] }[];
  ecosystems: { name: string; users: number; observations: number }[];
  tagEcosystemCounts: Record<string, Record<string, number>>;
  kinds: Record<TagKind, KindJson>;
  cases: Case[];
};
const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/resource-intent-tags-score-golden.json'), 'utf8')
) as Golden;

/** The fixture's index in the build's output shape (`TagIndexData`), which the encoder takes. */
function goldenData(g: Golden): TagIndexData {
  const idByKey = new Map(g.vocabulary.map((t, i) => [t.key, i]));
  const ecoId = new Map(g.ecosystems.map((e, i) => [e.name, i]));
  const sparse = (
    byKey: Record<string, Pairs>,
    id: (k: string) => number,
    idx: Map<number, number>
  ): SparseByKey => {
    const keys = Object.keys(byKey).sort((a, b) => id(a) - id(b));
    const ptr = [0];
    const entries = keys.flatMap((k) => {
      const e = byKey[k].map(([m, v]) => [idx.get(m) as number, v]).sort((a, b) => a[0] - b[0]);
      ptr.push(ptr[ptr.length - 1] + e.length);
      return e;
    });
    return {
      keys: Uint32Array.from(keys, id),
      ptr: Uint32Array.from(ptr),
      resource: Uint32Array.from(entries, (e) => e[0]),
      value: Float64Array.from(entries, (e) => e[1]),
    };
  };
  const tagId = (k: string) => idByKey.get(k) as number;
  const eco = (n: string) => ecoId.get(n) as number;
  const kind = (k: KindJson) => {
    const idx = new Map(k.modelIds.map((m, i) => [m, i]));
    const ptr = new Uint32Array(g.vocabulary.length + 1);
    const entries: [number, number, number][] = [];
    g.vocabulary.forEach((t, i) => {
      for (const [m, c, fit] of k.postings[t.key] ?? [])
        entries.push([idx.get(m) as number, c, fit ?? NaN]);
      ptr[i + 1] = entries.length;
    });
    const ecoPtr = [0];
    const ecoIds = k.ecosystems.flatMap((es) => {
      ecoPtr.push(ecoPtr[ecoPtr.length - 1] + es.length);
      return es.map(eco).sort((a, b) => a - b);
    });
    return {
      modelIds: Uint32Array.from(k.modelIds),
      fit: Float64Array.from(k.fit),
      ecosystemPtr: Uint32Array.from(ecoPtr),
      ecosystemIds: Uint32Array.from(ecoIds),
      postings: {
        ptr,
        resource: Uint32Array.from(entries, (e) => e[0]),
        c: Float64Array.from(entries, (e) => e[1]),
        fit: Float64Array.from(entries, (e) => e[2]),
      },
      ecosystemUsers: sparse(k.ecosystemUsers, eco, idx),
      userByTag: sparse(k.userByTag, tagId, idx),
      userByEcosystem: sparse(k.userByEcosystem, eco, idx),
    };
  };
  const counts = { ptr: [0], ecosystem: [] as number[], count: [] as number[] };
  g.vocabulary.forEach((t) => {
    for (const [e, n] of Object.entries(g.tagEcosystemCounts[t.key] ?? {}).sort(
      ([a], [b]) => eco(a) - eco(b)
    )) {
      counts.ecosystem.push(eco(e));
      counts.count.push(n);
    }
    counts.ptr.push(counts.ecosystem.length);
  });
  return {
    vocabVersion: 'a'.repeat(64),
    rowsWithEcosystem: g.ecosystems.reduce((n, e) => n + e.observations, 0),
    vocabulary: g.vocabulary.map((t) => ({ ...t, users: 1 })),
    ecosystems: g.ecosystems,
    tagEcosystemCounts: {
      ptr: Uint32Array.from(counts.ptr),
      ecosystem: Uint32Array.from(counts.ecosystem),
      count: Uint32Array.from(counts.count),
    },
    kinds: { addon: kind(g.kinds.addon), checkpoint: kind(g.kinds.checkpoint) },
  };
}

const index = tagIndexFromData(goldenData(golden));
const { index: decoded } = await decodeTagIndex(
  await encodeTagIndex(goldenData(golden), 'b'.repeat(64))
);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(b));

describe('resource-intent-tags scorer parity with the prototype', () => {
  it('the fixture is the one this test was written for', () => {
    expect(golden.cases.length).toBe(16);
    expect(golden.cases.filter((c) => c.noTags).length).toBe(2);
    expect(golden.cases.reduce((n, c) => n + (c.ranked?.length ?? 0), 0)).toBe(328);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = scoreTagRequest(index, {
      prompt: c.prompt,
      kind: c.kind,
      browsingLevel: c.browsingLevel,
      baseModel: c.baseModel,
    });
    const key = (i: number) => index.vocabulary[i].key;
    expect(r.foundTagIds.map(key).sort(compareCodePoints)).toEqual(c.found);
    // Weights in the prototype's own iteration order, which is the order every sum runs in.
    expect([...r.weights].map(([i, w]) => [key(i), w])).toEqual(
      c.keptWeights.map(([k, w]) => [k, expect.closeTo(w, 12)])
    );
    if (c.noTags) {
      expect(r).toMatchObject({
        status: 'no_tags',
        ecosystems: [],
        ecosystem: null,
        candidates: [],
      });
      return;
    }
    const known = golden.ecosystems.some((e) => e.name === c.ecosystem);
    expect(r.status).toBe(known ? 'ok' : 'unknown_ecosystem');
    expect(r.ecosystems).toEqual(c.ecosystems);
    expect(r.ecosystem).toBe(c.ecosystem);
    // The resolver's SCORES, not just its order: they move if a gated tag votes, or if the lift's
    // totals sum over the eligible ecosystems only instead of every one.
    const resolved = resolveEcosystems(index, r.weights, TAG_SCORE_PARAMS.ecosystemsReturned);
    expect(resolved.map((x) => [index.ecosystems[x.id].name, x.score])).toEqual(
      (c.resolver as [string, number][]).map(([e, sc]) => [e, expect.closeTo(sc, 12)])
    );
    // Every case is under the 300 cap, so this is the whole ranked list.
    const expected = c.ranked as Pairs;
    expect(r.candidates.length).toBe(c.candidateCount);
    expect(r.candidates.map((x) => x.modelId)).toEqual(expected.map(([m]) => m));
    r.candidates.forEach((x, i) => expect(x.score).toBeCloseTo(expected[i][1], 12));
    // Through the float32 snapshot: same order, scores to 1e-7.
    const d = scoreTagRequest(decoded, {
      prompt: c.prompt,
      kind: c.kind,
      browsingLevel: c.browsingLevel,
      baseModel: c.baseModel,
    });
    expect(d.candidates.map((x) => x.modelId)).toEqual(expected.map(([m]) => m));
    d.candidates.forEach((x, i) => expect(close(x.score, expected[i][1])).toBe(true));
  });

  it("a candidate cap below the list length keeps the uncapped ranking's leading order, ties included", () => {
    let checked = 0;
    for (const c of golden.cases.filter((x) => !x.noTags)) {
      const req = {
        prompt: c.prompt,
        kind: c.kind,
        browsingLevel: c.browsingLevel,
        baseModel: c.baseModel,
      };
      const full = scoreTagRequest(index, req).candidates;
      for (const k of [1, 2, 5, 13]) {
        if (k >= full.length) continue;
        const capped = scoreTagRequest(index, req, { ...TAG_SCORE_PARAMS, maxCandidates: k });
        expect(capped.candidates).toEqual(full.slice(0, k));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('reports no_ecosystem, unranked, when no ecosystem has enough training users', () => {
    const thin = { ...index, ecosystems: index.ecosystems.map((e) => ({ ...e, users: 99 })) };
    const c = golden.cases.find((x) => !x.noTags && !x.baseModel) as Case;
    const r = scoreTagRequest(thin, { ...c, baseModel: null });
    expect(r).toMatchObject({ status: 'no_ecosystem', ecosystems: [], ecosystem: null });
    expect(r.candidates).toEqual([]);
    expect(r.weights.size).toBeGreaterThan(0);
  });
});
