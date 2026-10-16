import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type {
  ResourceValues,
  TagIndex,
  TagIndexKind,
  TagKind,
} from '~/server/services/resource-intent-tags/score';
import { compareCodePoints } from '~/server/services/resource-intent-tags/extract';
import { scoreTagRequest, TAG_SCORE_PARAMS } from '~/server/services/resource-intent-tags/score';

/**
 * Parity: the scorer against the offline prototype's own output (V1 score, LEX request side, the
 * tag-derived ecosystem resolver) on a SYNTHETIC index: invented tag keys, ecosystems and model ids.
 * The generator built the index in the prototype's own data structures, ran the prototype's functions
 * on these requests and wrote what they returned; it also exported the index in the shape below. It
 * imports private code, so it is kept in the private infra repo. Never edit the fixture to make this
 * pass; regenerate it or fix the port.
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
  top?: Pairs;
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

function buildIndex(g: Golden): TagIndex {
  const idByKey = new Map(g.vocabulary.map((t, i) => [t.key, i]));
  const ecoId = new Map(g.ecosystems.map((e, i) => [e.name, i]));
  const tagId = (k: string) => idByKey.get(k) as number;
  const eco = (n: string) => ecoId.get(n) as number;
  const kind = (k: KindJson): TagIndexKind => {
    const idx = new Map(k.modelIds.map((m, i) => [m, i]));
    const values = (pairs: Pairs): ResourceValues => ({
      resource: Uint32Array.from(pairs, ([m]) => idx.get(m) as number),
      value: Float64Array.from(pairs, ([, v]) => v),
    });
    const ptr = new Uint32Array(g.vocabulary.length + 1);
    const entries: [number, number, number][] = [];
    for (let t = 0; t < g.vocabulary.length; t++) {
      for (const [m, c, fit] of k.postings[g.vocabulary[t].key] ?? [])
        entries.push([idx.get(m) as number, c, fit ?? NaN]);
      ptr[t + 1] = entries.length;
    }
    return {
      modelIds: k.modelIds,
      fit: Float64Array.from(k.fit),
      ecosystems: k.ecosystems.map((es) => es.map(eco)),
      postings: {
        ptr,
        resource: Uint32Array.from(entries, (e) => e[0]),
        c: Float64Array.from(entries, (e) => e[1]),
        fit: Float64Array.from(entries, (e) => e[2]),
      },
      ecosystemUsers: new Map(
        Object.entries(k.ecosystemUsers).map(([e, p]) => [eco(e), values(p)])
      ),
      userByTag: new Map(Object.entries(k.userByTag).map(([t, p]) => [tagId(t), values(p)])),
      userByEcosystem: new Map(
        Object.entries(k.userByEcosystem).map(([e, p]) => [eco(e), values(p)])
      ),
    };
  };
  return {
    vocabulary: g.vocabulary,
    idByKey,
    ecosystems: g.ecosystems,
    tagEcosystemCounts: new Map(
      Object.entries(g.tagEcosystemCounts).map(([t, c]) => [
        tagId(t),
        new Map(Object.entries(c).map(([e, n]) => [eco(e), n])),
      ])
    ),
    kinds: { addon: kind(g.kinds.addon), checkpoint: kind(g.kinds.checkpoint) },
  };
}

const index = buildIndex(golden);
const TOP = 50;

describe('resource-intent-tags scorer parity with the prototype', () => {
  it('the fixture is the one this test was written for', () => {
    expect(golden.cases.length).toBe(14);
    expect(golden.cases.filter((c) => c.noTags).length).toBe(2);
    expect(golden.cases.reduce((n, c) => n + (c.top?.length ?? 0), 0)).toBe(309);
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
      expect(r.status).toBe('no_tags');
      expect(r.candidates).toEqual([]);
      return;
    }
    expect(r.status).toBe('ok');
    expect(r.ecosystems).toEqual(c.ecosystems);
    expect(r.ecosystem).toBe(c.ecosystem);
    expect(r.candidates.length).toBe(c.candidateCount);
    const top = r.candidates.slice(0, TOP);
    expect(top.map((x) => x.modelId)).toEqual(c.top?.map(([m]) => m));
    top.forEach((x, i) => expect(x.score).toBeCloseTo((c.top as Pairs)[i][1], 12));
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
});
