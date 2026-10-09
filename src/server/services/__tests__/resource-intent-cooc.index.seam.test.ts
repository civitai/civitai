import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  CoocCountAccumulator,
  type CoocCounts,
} from '~/server/services/resource-intent-cooc/build';
import { loadScores, rankCooc } from '~/server/services/resource-intent-cooc/score';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';

/**
 * Seam: counts, scores and rankings against a golden file computed by the offline screen's
 * reference index builder (its Python `build` / `configure(lift, minSup 2, dfMax 0.05)` / `rank`,
 * run unmodified) over SYNTHETIC rows: tokens `tokNNNNN`, arbitrary model ids, no real data.
 *
 * The reference numbers its vocabulary in first-seen order; the shipped index sorts it. Only the
 * float summation order can differ between the two, so scores compare to a tight tolerance and
 * rankings compare exactly.
 */
type Golden = {
  config: { minSup: number; dfMax: number; beta: number; topK: number; addonTypes: string[] };
  rows: [string, [number, string][]][];
  expected: {
    N: number;
    nT: Record<string, number>;
    nM: Record<string, number>;
    modelTypes: Record<string, string>;
    rawPairs: number;
    keptPairs: [string, number, number, number][];
  };
  queries: {
    role: string;
    types: string[];
    q: string[];
    fullRankingLength: number;
    ranking: number[];
    scores: number[];
  }[];
};
const golden: Golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/resource-intent-cooc-golden.json'), 'utf8')
);
const rows = golden.rows.map(([t, m]) => ({ tokens: t ? t.split(' ') : [], models: m }));

function build(order: typeof rows) {
  const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  for (const r of order) acc.add(r.tokens, r.models);
  return acc.finalize(RESOURCE_INTENT_COOC_SPEC);
}

const closeTo = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));

describe('cooc index seam: shipped == screen reference', () => {
  const counts = build(rows);
  const scores = loadScores(counts, RESOURCE_INTENT_COOC_SPEC);

  it('the spec is the configuration the reference ran with', () => {
    const s = RESOURCE_INTENT_COOC_SPEC;
    expect([s.minSup, s.dfMax, s.beta, s.topK]).toEqual([2, 0.05, 10, 300]);
    expect({ ...golden.config, addonTypes: [...golden.config.addonTypes].sort() }).toEqual({
      minSup: s.minSup,
      dfMax: s.dfMax,
      beta: s.beta,
      topK: s.topK,
      addonTypes: [...s.addonTypes],
    });
  });

  it('N, n_t, n_m, model types and raw pair count are identical', () => {
    expect(counts.N).toBe(golden.expected.N);
    expect(counts.rawVocab).toBe(Object.keys(golden.expected.nT).length);
    // The snapshot keeps exactly the tokens that have a kept pair, each with the reference n_t.
    const keptTokens = [...new Set(golden.expected.keptPairs.map((x) => x[0]))].sort();
    expect(counts.vocab).toEqual(keptTokens);
    expect(counts.vocab.length).toBeLessThan(counts.rawVocab);
    expect(Object.fromEntries(counts.vocab.map((t, i) => [t, counts.nT[i]]))).toEqual(
      Object.fromEntries(keptTokens.map((t) => [t, golden.expected.nT[t]]))
    );
    expect(Object.fromEntries(counts.modelIds.map((m, i) => [String(m), counts.nM[i]]))).toEqual(
      golden.expected.nM
    );
    expect(
      Object.fromEntries(counts.modelIds.map((m, i) => [String(m), counts.modelTypes[i]]))
    ).toEqual(golden.expected.modelTypes);
    expect(counts.rawPairs).toBe(golden.expected.rawPairs);
  });

  it('the kept pairs (after minSup, the df cut and s > 0) are identical, with matching s', () => {
    const got: [string, number, number, number][] = [];
    for (let t = 0; t < counts.vocab.length; t++)
      for (let k = counts.ptr[t]; k < counts.ptr[t + 1]; k++)
        got.push([counts.vocab[t], counts.modelIds[counts.modelIdx[k]], counts.c[k], scores.s[k]]);
    const key = (x: [string, number, ...unknown[]]) => `${x[0]}|${x[1]}`;
    const want = [...golden.expected.keptPairs].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]
    );
    expect(got.map((x) => `${key(x)}|${x[2]}`)).toEqual(want.map((x) => `${key(x)}|${x[2]}`));
    got.forEach((x, i) => expect(closeTo(x[3], want[i][3]), key(x)).toBe(true));
    // Positive control: the fixture exercises every cut.
    const dfCut = Object.values(golden.expected.nT).filter((n) => n > 0.05 * counts.N).length;
    expect(dfCut).toBeGreaterThan(0);
    expect(counts.vocab.filter((_, i) => counts.nT[i] > 0.05 * counts.N)).toEqual([]);
    expect(got.length).toBeLessThan(golden.expected.rawPairs / 4);
  });

  it(`every one of ${golden.queries.length} rankings is identical (order, ties, types, cut)`, () => {
    let nonEmpty = 0;
    for (const q of golden.queries) {
      const full = rankCooc(scores, q.q, q.types, Number.MAX_SAFE_INTEGER);
      expect(
        full.map((c) => c.modelId),
        q.role
      ).toEqual(q.ranking);
      full.forEach((c, i) => expect(closeTo(c.score, q.scores[i])).toBe(true));
      expect(rankCooc(scores, q.q, q.types, 10).map((c) => c.modelId)).toEqual(
        q.ranking.slice(0, 10)
      );
      expect(
        rankCooc(scores, q.q, q.types, RESOURCE_INTENT_COOC_SPEC.topK).map((c) => c.modelId)
      ).toEqual(q.ranking.slice(0, 300));
      if (q.ranking.length) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(40);
    // The fixture holds exact score ties, so the model-id tie-break is exercised.
    const ties = golden.queries.some((q) =>
      q.scores.some((s, i) => i > 0 && s === q.scores[i - 1])
    );
    expect(ties).toBe(true);
  });

  it('the df cut is inclusive: n_t exactly dfMax·N is kept, one more row is cut', () => {
    // N = 100, dfMax 0.05: a token in 5 rows with model 1 in all 5 has s = ln(5·100/(15·5)) > 0.
    const build100 = (rowsWithToken: number) => {
      const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
      for (let i = 0; i < 100; i++)
        acc.add(
          i < rowsWithToken ? ['tok00001'] : ['tok00002'],
          i < 5 ? [[1, 'LORA']] : [[2, 'LORA']]
        );
      return acc.finalize(RESOURCE_INTENT_COOC_SPEC);
    };
    expect(build100(5).vocab).toContain('tok00001');
    expect(build100(6).vocab).not.toContain('tok00001');
  });

  it('a model seen with two add-on types keeps the first, counts every row and the conflict', () => {
    const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
    acc.add(['tok00001'], [[7, 'LoCon']]);
    acc.add(['tok00001'], [[7, 'LORA']]);
    acc.add(['tok00001'], [[7, 'LoCon']]);
    acc.add(['tok00001'], [[7, 'Checkpoint']]);
    const c = acc.finalize(RESOURCE_INTENT_COOC_SPEC);
    expect(c.modelTypes).toEqual(['LoCon']);
    expect([...c.nM]).toEqual([3]);
    expect(c.typeConflicts).toBe(1);
  });

  it('an accumulator finalizes once and takes no rows after', () => {
    const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
    acc.add(['tok00001'], [[1, 'LORA']]);
    acc.finalize(RESOURCE_INTENT_COOC_SPEC);
    expect(() => acc.finalize(RESOURCE_INTENT_COOC_SPEC)).toThrow(/already finalized/);
    expect(() => acc.add(['tok00002'], [[1, 'LORA']])).toThrow(/already finalized/);
  });

  it('a role with no types, or null types, gets no candidates', () => {
    const q = golden.queries.find((x) => x.ranking.length > 5) as Golden['queries'][number];
    expect(rankCooc(scores, q.q, null, 300)).toEqual([]);
    expect(rankCooc(scores, q.q, [], 300)).toEqual([]);
  });

  it('the counts do not depend on row order, token order or repeated tokens', () => {
    const rand = (() => {
      let a = 99;
      return () => (a = (a * 1103515245 + 12345) >>> 0) / 2 ** 32;
    })();
    const shuffled = rows
      .map((r) => ({
        tokens: [...r.tokens, ...r.tokens.slice(0, 2)].sort(() => rand() - 0.5),
        models: [...r.models].reverse(),
      }))
      .sort(() => rand() - 0.5);
    const a: CoocCounts = build(rows);
    const b: CoocCounts = build(shuffled);
    expect(b).toEqual(a);
  });
});
