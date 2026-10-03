import { dbRead } from '~/server/db/client';

/**
 * `ResourceInsight` reading — the shape, the confidence floors, the loader, and the
 * model-level projection used by the search index.
 *
 * 🔴 Kept a LEAF (no `~/server/meilisearch/client`, no search-index module) because it
 * has TWO consumers that must not import each other:
 *   - `./resource-intent-matcher.service.ts`, which re-ranks a shortlist, and
 *   - `~/server/search-index/models.search-index.ts`, which projects a model-level
 *     score into the index so Meilisearch can order by it.
 * The matcher already does `import type { ModelSearchIndexRecord }` from the search
 * index. That is type-only and erases at runtime, so it is not a cycle today — but a
 * VALUE import in the other direction would make it one. Hence this module: both sides
 * depend on it, neither depends on the other. Same reasoning as
 * `~/server/search-index/sortable-attributes.ts`.
 *
 * It also keeps the `stale: false` predicate and the promote floor single-sourced. Both
 * were previously readable only from inside the matcher, which is where a second
 * open-coded copy would have gone.
 */
export type ResourceIntentInsight = {
  role: string;
  styleFamily: string;
  qualityScore: number;
  confidence: number;
};

/**
 * The floor for PROMOTION. `ResourceInsight.confidence` is the WEAKEST of a row's
 * four label judgments — including the `contentType` one this ordering never reads
 * — and the written distribution is p50 0.43 / mean 0.44 with only 3.4% of rows at
 * or above 0.70. So a 0.70 floor would discard ~96.6% of the labels and leave this
 * ordering inert; 0.30 is the measured ~12.8th percentile.
 *
 * ⚠️ Read that argument for what it weighs: the cost of a HIGH floor on this side
 * is a label that never gets to help, i.e. the feature doing nothing. It says
 * nothing about the demote side, which is why that side has its own constant below.
 */
export const RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE = 0.3;

/**
 * The floor for DEMOTION — a separate constant because the two directions have
 * ASYMMETRIC error costs and only the promote side has ever been argued.
 *
 * 🔴 This value is INHERITED from the promote-side argument above, not derived for
 * demotion. It is set equal to it so today's behaviour is unchanged; the split
 * exists so the demote floor can be moved in a validation window without touching
 * the promote floor, which until now it could not be.
 *
 * The asymmetry, stated so the next person does not have to re-derive it. Raising
 * THIS floor costs a missed demotion, and a row that fails to demote simply sits
 * neutral — seed order, which is the pre-feature behaviour. Raising the promote
 * floor costs the ordering its reason to exist. And the demote side's mistakes are
 * not merely reorderings: the permutation is sliced to the response cap, so a
 * demotion on a pool wider than the cap evicts a candidate from the returned page.
 *
 * Measured on a realistic approximation of a pool (not through this function): in
 * the worst cell sampled the demote bucket held 49 of 100 candidates, with median
 * confidence 0.45 and NONE at or above 0.70. So at this floor the bucket is a large
 * minority of a pool rather than a rare correction, and it is not selected by high
 * confidence — which is why neither this file nor the contract doc calls it the
 * "confident" bucket any more.
 *
 * Deliberately NOT raised here: where to put it is a product judgment about how
 * much eviction an unvalidated label is allowed to cause, and that judgment has not
 * been made.
 */
export const RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE = 0.3;

/**
 * 🔴 `stale: false` is a floor, not a freshness guarantee. Nothing in this repo
 * sets `stale = true` — the migration describes that flip as a manual step of a
 * label-spec bump — so today the clause excludes no row, and `specHash` is
 * deliberately NOT compared: filtering on it would make the whole ordering inert
 * from the moment a spec moves until a manual, vendor-spend-gated re-label pass
 * finished, and the table was designed so superseded rows stay readable. The
 * harm a superseded row could do is handled in `insightBucket` (in
 * `./resource-intent-matcher.service.ts`) instead, by refusing to demote on a
 * value this build cannot interpret. What is NOT covered either way is a spec
 * that keeps an option's spelling and changes its meaning; that one needs the
 * manual flip.
 */
export async function loadResourceInsights(
  versionIds: number[]
): Promise<Map<number, ResourceIntentInsight>> {
  if (!versionIds.length) return new Map();
  const rows = await dbRead.resourceInsight.findMany({
    where: { modelVersionId: { in: versionIds }, stale: false },
    select: {
      modelVersionId: true,
      role: true,
      styleFamily: true,
      qualityScore: true,
      confidence: true,
    },
  });
  return new Map(rows.map((row) => [row.modelVersionId, row]));
}

/**
 * The model-level projection: what ONE `insight.qualityScore` a model's search
 * document should carry, given that labels are VERSION-level and the models index is
 * MODEL-level.
 *
 * The rule is MAX over the model's labeled versions that clear
 * `RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE`. This is a PRODUCT CHOICE, not a
 * derivation — recorded here because the alternatives are defensible and the next
 * reader should not have to guess which one was picked or why:
 *   - MAX (chosen): "best for X" reads as the model's best showing, and a model is
 *     downloaded as a whole, so its strongest version is what a user can actually
 *     get. Moot for the large majority of labeled models in any case — measured
 *     2026-10-03, 6,801 of 7,886 labeled models (86.2%) have exactly ONE labeled
 *     version, so the rule only arbitrates for 1,085 of them.
 *   - LATEST: tracks what a user would download today, but one weak new version can
 *     demote a model whose earlier version is the good one.
 *   - MEAN: smooths vendor noise, but dilutes a genuinely excellent version and mixes
 *     sub-floor rows back into the figure the floor exists to exclude.
 *
 * 🔴 Returns `null`, and the caller must then OMIT the key rather than write a
 * sentinel or a zero. That is load-bearing and was MEASURED against the production
 * engine (Meilisearch v1.15.0), not assumed:
 *   - documents MISSING a sortable attribute are NOT dropped from a sorted result;
 *   - they sort LAST in BOTH directions (`:desc` and `:asc` alike — this is not
 *     conventional "nulls last", which would flip), so unlabeled models can never
 *     displace labeled ones at the head whichever way the sort runs;
 *   - an explicit `null` behaves identically to an absent field, so omission is the
 *     cheaper spelling of the same thing;
 *   - a SECOND sort key fully orders that trailing group, which is what lets the
 *     caller tier insight over popularity without inventing a default.
 * A sentinel (say `-1` for every unlabeled model) would be strictly worse: ~718k
 * extra document writes to buy an ordering that already exists, and under `:asc` it
 * would surface the unlabeled block FIRST.
 */
export function modelInsightQualityScore(
  versionIds: number[],
  insights: Map<number, ResourceIntentInsight>
): number | null {
  let best: number | null = null;
  for (const versionId of versionIds) {
    const insight = insights.get(versionId);
    if (!insight) continue;
    if (insight.confidence < RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE) continue;
    if (best === null || insight.qualityScore > best) best = insight.qualityScore;
  }
  return best;
}
