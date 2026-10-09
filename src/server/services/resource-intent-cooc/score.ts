import type { CoocCounts } from './build';

/**
 * Serving side of the co-occurrence index, as pure functions: scores from stored counts, and the
 * ranked candidate list for a prompt. A port of the offline screen's reference `configure` (lift
 * weight) and `rank`.
 */

export type CoocScores = {
  vocabIndex: ReadonlyMap<string, number>;
  ptr: Uint32Array;
  modelIdx: Uint32Array;
  s: Float64Array;
  modelIds: readonly number[];
  modelTypes: readonly string[];
};

/** s = ln(c·N / ((n_t + β)·n_m)) for every stored pair; the builder kept only pairs with s > 0. */
export function loadScores(counts: CoocCounts, params: { beta: number }): CoocScores {
  const s = new Float64Array(counts.modelIdx.length);
  const V = counts.vocab.length;
  for (let t = 0; t < V; t++) {
    const nt = counts.nT[t];
    for (let k = counts.ptr[t]; k < counts.ptr[t + 1]; k++) {
      s[k] = Math.log(
        (counts.c[k] * counts.N) / ((nt + params.beta) * counts.nM[counts.modelIdx[k]])
      );
    }
  }
  return {
    vocabIndex: new Map(counts.vocab.map((t, i) => [t, i])),
    ptr: counts.ptr,
    modelIdx: counts.modelIdx,
    s,
    modelIds: counts.modelIds,
    modelTypes: counts.modelTypes,
  };
}

export type CoocCandidate = { modelId: number; score: number };

/**
 * A model's score is the sum of s over the query's distinct in-vocabulary tokens, summed in
 * ascending token id (the float sum is order-sensitive, so the order is part of the result). Only
 * models of `allowedTypes` with a positive score qualify; null or empty types yield nothing. Ranked
 * by score descending then model id ascending, first `topK` kept.
 */
export function rankCooc(
  scores: CoocScores,
  queryTokens: readonly string[],
  allowedTypes: readonly string[] | null,
  topK: number
): CoocCandidate[] {
  if (!allowedTypes?.length || topK <= 0) return [];
  const tids = [
    ...new Set(
      queryTokens.map((t) => scores.vocabIndex.get(t)).filter((t): t is number => t !== undefined)
    ),
  ].sort((a, b) => a - b);
  const sc = new Map<number, number>();
  for (const t of tids) {
    for (let k = scores.ptr[t]; k < scores.ptr[t + 1]; k++) {
      const m = scores.modelIdx[k];
      sc.set(m, (sc.get(m) ?? 0) + scores.s[k]);
    }
  }
  const allowed = new Set(allowedTypes);
  const cands: number[] = [];
  for (const [m, v] of sc) if (v > 0 && allowed.has(scores.modelTypes[m])) cands.push(m);
  // modelIds ascend with their index, so the index breaks ties by model id.
  cands.sort((a, b) => (sc.get(b) as number) - (sc.get(a) as number) || a - b);
  return cands
    .slice(0, topK)
    .map((m) => ({ modelId: scores.modelIds[m], score: sc.get(m) as number }));
}
