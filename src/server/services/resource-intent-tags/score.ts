import { matureBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { compareCodePoints, tagKeys } from './extract';
import type { GroupingTag } from './groups';
import { keptWeights } from './groups';

/**
 * Serving side of the v1 content-tag arm, as pure functions over an in-memory index: the request's
 * kept tags and weights, the tag-derived ecosystem, and the ranked candidate list. A port of the
 * offline prototype's V1 score on the LEX request side, the variant and side the judged screen adopted:
 *
 *   S(r) = M(r)·exp(λ·F(r)) + β_U·U(r) + β_P·P(r)
 *
 * `src/server/services/__tests__/resource-intent-tags.score.parity.test.ts` holds it to the prototype's
 * own output on a synthetic index. Nothing here reads a database; a snapshot decoder fills the index.
 */

/** The scorer's constants, as the prototype registered and screened them. Change only with a new screen. */
export const TAG_SCORE_PARAMS = {
  /** λ, the outcome-fit exponent. */
  fitExponent: 1,
  /** β_U, the weight of the user-side score. */
  userWeight: 0.05,
  /** β_P, the weight of the popularity prior. */
  popularityWeight: 0.02,
  /** The ecosystem distribution's weight inside the user-side score. */
  userEcosystemWeight: 0.05,
  /** Candidates kept, before the resource gates. */
  maxCandidates: 300,
  /** Dirichlet prior strength of the (tag, ecosystem) lift. */
  liftPrior: 50,
  /** An ecosystem is a resolver answer only with at least this many training users. */
  ecosystemMinUsers: 100,
  /** Tag-derived ecosystems returned to a caller that gave no baseModel. */
  ecosystemsReturned: 3,
} as const;
export type TagScoreParams = { [K in keyof typeof TAG_SCORE_PARAMS]: number };

export type TagKind = 'addon' | 'checkpoint';

/** One tag of the frozen vocabulary. Its id is its position. */
export type TagVocabularyEntry = GroupingTag & { explicit: boolean };

/** A sparse list of values over one kind's resources: `resource` holds indices into that kind's arrays. */
export type ResourceValues = { resource: Uint32Array; value: Float64Array };

/** One kind's part of the index. */
export type TagIndexKind = {
  /** Model ids, ascending: a resource's index is its position, so index order breaks score ties. */
  modelIds: readonly number[];
  /** Each resource's own shrunk outcome fit; 0 without evidence. */
  fit: Float64Array;
  /** Ecosystem ids each resource is published for. */
  ecosystems: readonly (readonly number[])[];
  /**
   * Per tag id, its resources in ascending index, CSR: entries `ptr[t]` to `ptr[t + 1]`. `c` is the
   * content score (0 for a pair known only from use); `fit` the (resource, tag) shrunk fit, NaN where
   * fewer than 2 users back it.
   */
  postings: { ptr: Uint32Array; resource: Uint32Array; c: Float64Array; fit: Float64Array };
  /** Per ecosystem id: users of each resource there (the popularity prior). */
  ecosystemUsers: ReadonlyMap<number, ResourceValues>;
  /**
   * The user-side distributions: per tag id and per ecosystem id, each resource's share. The
   * ecosystem's resources are also its compatibility set.
   */
  userByTag: ReadonlyMap<number, ResourceValues>;
  userByEcosystem: ReadonlyMap<number, ResourceValues>;
};

export type TagIndexEcosystem = {
  name: string;
  /** Distinct training users. */
  users: number;
  /** Training observations. */
  observations: number;
};

export type TagIndex = {
  vocabulary: readonly TagVocabularyEntry[];
  idByKey: ReadonlyMap<string, number>;
  /** Every ecosystem the index names; its id is its position. */
  ecosystems: readonly TagIndexEcosystem[];
  /** Per tag id, training observations per ecosystem id. A tag without an entry casts no ecosystem vote. */
  tagEcosystemCounts: ReadonlyMap<number, ReadonlyMap<number, number>>;
  kinds: Readonly<Record<TagKind, TagIndexKind>>;
};

/** A request may match an explicit tag only when its (already clamped) browsing level includes R, X or XXX. */
export function matureAllowed(browsingLevel: number): boolean {
  return (browsingLevel & matureBrowsingLevelsFlag) !== 0;
}

/**
 * The Dirichlet-smoothed lift of a tag on an ecosystem, P(e|t) / P(e) with P(e|t) = (c_te + m·P(e)) /
 * (c_t + m), P(e) = n_e / N; counts are training observations and c_t is over every ecosystem. An
 * unseen (tag, ecosystem) pair gets m / (c_t + m) < 1 rather than 0.
 */
export function ecosystemLift(
  count: number,
  tagTotal: number,
  ecosystemObservations: number,
  totalObservations: number,
  prior: number
): number {
  const share = ecosystemObservations / totalObservations;
  return (count + (prior * ecosystemObservations) / totalObservations) / (tagTotal + prior) / share;
}

/**
 * Ecosystems ranked by Σ_t w_t·ln lift(t, e) (`ecosystemLift`), best first, at most `limit`. Only
 * ecosystems with at least `ecosystemMinUsers` users are ranked, in order of users descending then
 * name, and equal scores keep that order. A tag without counts casts no vote.
 */
export function resolveEcosystems(
  index: Pick<TagIndex, 'ecosystems' | 'tagEcosystemCounts'>,
  weights: ReadonlyMap<number, number>,
  limit: number,
  params: Pick<TagScoreParams, 'liftPrior' | 'ecosystemMinUsers'> = TAG_SCORE_PARAMS
): number[] {
  const m = params.liftPrior;
  const N = index.ecosystems.reduce((s, e) => s + e.observations, 0);
  const eligible = index.ecosystems
    .map((e, id) => ({ e, id }))
    .filter((x) => x.e.users >= params.ecosystemMinUsers)
    .sort((a, b) => b.e.users - a.e.users || compareCodePoints(a.e.name, b.e.name));
  const votes = [...weights].flatMap(([t, w]) => {
    const counts = index.tagEcosystemCounts.get(t);
    if (!counts) return [];
    let total = 0;
    for (const c of counts.values()) total += c;
    return [{ w, counts, total }];
  });
  const scored = eligible.map(({ e, id }) => {
    let score = 0;
    for (const v of votes)
      score += v.w * Math.log(ecosystemLift(v.counts.get(id) ?? 0, v.total, e.observations, N, m));
    return { id, score };
  });
  // Stable: equal scores keep the eligibility order.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.id);
}

export type TagCandidate = { modelId: number; score: number };

/** Index order of `score` descending, then index ascending (= model id ascending). */
const before = (score: Float64Array, a: number, b: number) =>
  score[a] > score[b] || (score[a] === score[b] && a < b);

/** The first `k` of `cands` in `before` order, without sorting all of them. */
function topK(cands: number[], score: Float64Array, k: number): number[] {
  if (cands.length <= k) return cands.sort((a, b) => (before(score, a, b) ? -1 : 1));
  // A heap of the best k so far whose root is the WORST of them.
  const heap: number[] = [];
  const worse = (a: number, b: number) => before(score, b, a);
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!worse(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let w = i;
      if (l < heap.length && worse(heap[l], heap[w])) w = l;
      if (r < heap.length && worse(heap[r], heap[w])) w = r;
      if (w === i) return;
      [heap[i], heap[w]] = [heap[w], heap[i]];
      i = w;
    }
  };
  for (const c of cands) {
    if (heap.length < k) {
      heap.push(c);
      up(heap.length - 1);
    } else if (before(score, c, heap[0])) {
      heap[0] = c;
      down(0);
    }
  }
  return heap.sort((a, b) => (before(score, a, b) ? -1 : 1));
}

/**
 * The ranked candidates of one kind on one ecosystem. Candidates are the resources published for the
 * ecosystem or in its user-side compatibility set, with content match M > 0 or user-side score > 0:
 * - M(r) = Σ_t w_t·c(r,t) / W and F(r) = fit(r) + Σ_t w_t·(fit(r,t) − fit(r)) / W over the pairs with a
 *   (resource, tag) fit, W = Σ_t w_t (1 when 0), every sum in the weights' iteration order;
 * - U(r) = Σ_t w_t·share_t(r) over compatible resources (every resource when the ecosystem has no
 *   compatibility set) + ε·share_e(r), divided by its maximum over the kind;
 * - P(r) = ln(1 + users_e(r)) / ln(1 + max users_e over the kind).
 * Ranked by S descending then model id ascending; the first `maxCandidates` kept.
 */
export function rankTagCandidates(
  kind: TagIndexKind,
  ecosystem: number,
  weights: ReadonlyMap<number, number>,
  params: Omit<
    TagScoreParams,
    'liftPrior' | 'ecosystemMinUsers' | 'ecosystemsReturned'
  > = TAG_SCORE_PARAMS
): TagCandidate[] {
  const n = kind.modelIds.length;
  const { ptr, resource, c, fit } = kind.postings;
  let W = 0;
  for (const w of weights.values()) W += w;
  W ||= 1;

  const match = new Float64Array(n);
  const fitDelta = new Float64Array(n);
  for (const [t, w] of weights) {
    for (let k = ptr[t]; k < ptr[t + 1]; k++) {
      const r = resource[k];
      match[r] += c[k] * w;
      if (!Number.isNaN(fit[k])) fitDelta[r] += (fit[k] - kind.fit[r]) * w;
    }
  }

  const compatible = kind.userByEcosystem.get(ecosystem);
  const inEcosystem = new Uint8Array(n);
  for (let r = 0; r < n; r++) if (kind.ecosystems[r].includes(ecosystem)) inEcosystem[r] = 1;
  if (compatible) for (const r of compatible.resource) inEcosystem[r] = 1;

  const user = new Float64Array(n);
  let compatMask: Uint8Array | null = null;
  if (compatible) {
    compatMask = new Uint8Array(n);
    for (const r of compatible.resource) compatMask[r] = 1;
  }
  for (const [t, w] of weights) {
    const d = kind.userByTag.get(t);
    if (!d) continue;
    for (let k = 0; k < d.resource.length; k++) {
      const r = d.resource[k];
      if (!compatMask || compatMask[r]) user[r] += w * d.value[k];
    }
  }
  if (compatible)
    for (let k = 0; k < compatible.resource.length; k++)
      user[compatible.resource[k]] += params.userEcosystemWeight * compatible.value[k];
  let userMax = 0;
  for (let r = 0; r < n; r++) if (user[r] > userMax) userMax = user[r];

  const popularity = new Float64Array(n);
  const eu = kind.ecosystemUsers.get(ecosystem);
  if (eu) {
    let max = 0;
    for (const v of eu.value) if (v > max) max = v;
    if (max > 0) {
      const denom = Math.log1p(max);
      for (let k = 0; k < eu.resource.length; k++)
        popularity[eu.resource[k]] = Math.log1p(eu.value[k]) / denom;
    }
  }

  const score = new Float64Array(n);
  const cands: number[] = [];
  for (let r = 0; r < n; r++) {
    if (!inEcosystem[r] || !(match[r] / W > 0 || user[r] > 0)) continue;
    const M = match[r] / W;
    const F = kind.fit[r] + fitDelta[r] / W;
    const Un = userMax > 0 ? user[r] / userMax : user[r];
    score[r] =
      M * Math.exp(params.fitExponent * F) +
      params.userWeight * Un +
      params.popularityWeight * popularity[r];
    cands.push(r);
  }
  return topK(cands, score, params.maxCandidates).map((r) => ({
    modelId: kind.modelIds[r],
    score: score[r],
  }));
}

export type TagRequest = {
  prompt: string;
  kind: TagKind;
  /** The token-clamped browsing level. */
  browsingLevel: number;
  /** The caller's ecosystem; when absent the tags choose one. */
  baseModel?: string | null;
};

export type TagScoreResult = {
  /** Vocabulary ids written literally in the prompt, before the explicit gate. */
  foundTagIds: number[];
  /** Weights of the tags that passed the gate, in summation order. */
  weights: Map<number, number>;
  /** `no_tags`: nothing passed the gate, so nothing was ranked. */
  status: 'ok' | 'no_tags';
  /** Tag-derived ecosystems, best first; only when the request had no baseModel. */
  ecosystems: string[];
  /** The ecosystem the candidates were ranked on. */
  ecosystem: string | null;
  candidates: TagCandidate[];
};

/** One request end to end: literal tags, explicit gate, weights, ecosystem, ranked candidates. */
export function scoreTagRequest(
  index: TagIndex,
  req: TagRequest,
  params: TagScoreParams = TAG_SCORE_PARAMS
): TagScoreResult {
  const foundTagIds: number[] = [];
  for (const k of tagKeys(req.prompt)) {
    const id = index.idByKey.get(k);
    if (id !== undefined) foundTagIds.push(id);
  }
  const mature = matureAllowed(req.browsingLevel);
  const kept = foundTagIds.filter((i) => mature || !index.vocabulary[i].explicit);
  const weights = keptWeights(foundTagIds, kept, index.vocabulary);
  const empty = { foundTagIds, weights, ecosystems: [], ecosystem: null, candidates: [] };
  if (!weights.size) return { ...empty, status: 'no_tags' };

  const ecosystems = req.baseModel
    ? []
    : resolveEcosystems(index, weights, params.ecosystemsReturned, params).map(
        (id) => index.ecosystems[id].name
      );
  const ecosystem = req.baseModel || ecosystems[0];
  if (!ecosystem) return { ...empty, status: 'ok' };
  const ecoId = index.ecosystems.findIndex((e) => e.name === ecosystem);
  const candidates =
    ecoId < 0 ? [] : rankTagCandidates(index.kinds[req.kind], ecoId, weights, params);
  return { foundTagIds, weights, status: 'ok', ecosystems, ecosystem, candidates };
}
