import { dbRead } from '~/server/db/client';

/**
 * `ResourceInsight` reading — the shape, the confidence floors, the loader, and the
 * model-level projection used by the search index.
 *
 * 🔴 Kept a LEAF because it has TWO consumers:
 *   - `./resource-intent-matcher.service.ts`, which re-ranks a shortlist, and
 *   - `~/server/search-index/models.search-index.ts`, which projects a model-level
 *     score into the index so Meilisearch can order by it.
 *
 * ⚠ **The reason is DEPENDENCY DIRECTION and single-sourcing — NOT a runtime cycle.** An
 * earlier version of this header said a value import from the search index back to the
 * matcher "would close a real cycle", and that is WRONG: the matcher's only reference to
 * the search index is `import type { ModelSearchIndexRecord }`, which `isolatedModules`
 * erases unconditionally, so such an import would be ONE directed edge and no cycle at
 * all (and `import/no-cycle` is commented out in `.eslintrc.js`, so nothing enforces it
 * either way). Do not let that sentence stop a legitimate refactor; the cycle would only
 * appear if the matcher's type-only import ever became a VALUE import.
 *
 * What DOES justify this module, and is sufficient on its own:
 *   - a search-index BUILDER value-importing a search-CONSUMING re-ranker is backwards, and
 *   - the alternative is open-coding the `stale: false` predicate and the promote floor a
 *     second time — the "one rule, one place" bug-generator. Both were previously readable
 *     only from inside the matcher, which is exactly where that second copy would have gone.
 *
 * ⚠ Not the same reasoning as `~/server/search-index/sortable-attributes.ts`: that one is a
 * leaf so a test can read it WITHOUT loading `~/server/meilisearch/client`. This module
 * imports `dbRead`, so it is not a light leaf, and its consumer already loads the meili
 * client anyway.
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
 * What a model's search document carries under `insight`: the three meaning axes, all taken
 * from ONE version's label row, plus the id of the version that row came from. See
 * `modelInsightProjection` for why the row travelling together matters.
 *
 * The axes half is expressed as `Omit<…, 'confidence'>` rather than three restated fields, so
 * the relationship — "the document carries the whole label row EXCEPT the internal
 * label-quality judgment" — is machine-checked instead of prose. Adding a column to
 * `ResourceIntentInsight` then fails the projection's own `return` until someone decides
 * whether the document should carry it, which is the decision that ought to be forced.
 *
 * 🔴 `modelVersionId` IS DELIBERATELY AN INTERSECTION, NOT A WIDENED `Omit`, BECAUSE THE ROW
 * TYPE DOES NOT DECLARE IT. `ResourceIntentInsight` has four fields and that is not one of
 * them — `loadResourceInsights` does select the `modelVersionId` COLUMN, but it is spent as
 * the map KEY and never surfaces in the value type. So the id this projection returns is read
 * off that key, which is the only id the function is typed to see, and it cannot be obtained
 * by relaxing the `Omit`. Writing it as `Omit<ResourceIntentInsight, 'confidence' | …>` would
 * also quietly stop forcing the add-a-column decision the paragraph above buys.
 */
export type ModelInsightProjection = Omit<ResourceIntentInsight, 'confidence'> & {
  /**
   * The version whose label row the three axes above came from — the MAP KEY of the winner,
   * not a column of the row. `null` is impossible here: a non-null projection means some
   * version won, and the caller's `?? null` covers the whole-object-null case.
   */
  modelVersionId: number;
};

/**
 * The model-level projection: what ONE `insight` object a model's search document
 * should carry, given that labels are VERSION-level and the models index is
 * MODEL-level.
 *
 * 🔴 IT RETURNS A WHOLE ROW, NOT THREE INDEPENDENTLY-SELECTED FIELDS, AND THAT IS THE
 * POINT OF THE FUNCTION. `role` and `styleFamily` describe the SAME resource the
 * winning `qualityScore` was measured on. Selecting each axis on its own — max score
 * from one version, role from another — produces a document whose axes describe
 * different resources: a purpose filter would then match a model on a role no version
 * of it that scored well actually has. Nothing downstream can detect that: every field
 * is individually well-formed, the document validates, and the index answers normally.
 * So the row travels together, and the test that pins it
 * (~/server/services/__tests__/resource-insight.test.ts) uses a fixture whose
 * highest-scoring version carries a DIFFERENT role from its lower-scoring one.
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
 * 🔴 TIES ARE BROKEN ON THE LOWEST `modelVersionId`, and a tiebreak is REQUIRED rather
 * than cosmetic now that the row travels. For the score alone a tie was invisible — equal
 * scores produce the same number whichever version wins — but `role` and `styleFamily`
 * are not equal across a tie, so an unspecified winner means the projected role can FLIP
 * between two reindexes with no label change behind it.
 *
 * ⚠️ "Whichever comes first in `versionIds`" would NOT have been deterministic, which is
 * why it was not chosen. The caller's list comes from `modelSearchIndexSelect`
 * (~/server/selectors/model.selector.ts), which orders `modelVersions` by
 * `{ index: 'asc' }` — and `ModelVersion.index` is `Int?` (nullable) and is the creator's
 * own display ordering, so it is both reorderable by a creator at any time and tied/NULL
 * across rows. Ordering on it therefore leaves the winner of a score tie unpinned.
 * `modelVersionId` is the table's immutable primary key, so this tiebreak is stable
 * across reindexes AND independent of the order the ids arrive in — which is what lets
 * the behavioural test assert order-independence for the ROW, not just the number.
 *
 * 🔴 Returns `null`, and the caller must WRITE that null — `insight: { qualityScore: null,
 * role: null, styleFamily: null, modelVersionId: null }`, every key present
 * — rather than a sentinel, a zero, or an omitted key. ⚠️ An earlier version of this
 * docstring said to OMIT it, on the measured ground that a missing sortable attribute and
 * an explicit null sort identically. They do; sorting was simply the wrong property to
 * check. Every live write is a MERGE (`PUT /indexes/<uid>/documents`), so on a document
 * that already carries a score, omitting the key leaves the OLD value in place — a
 * retracted label would stay visible to any filter or sort on it permanently. Measured both arms on
 * v1.15.0: a PUT of the null cleared a stored 0.9, and the control PUT with no key at all
 * left a stored 0.1 intact.
 *
 * The rest of the engine behaviour, all measured and all still true:
 *   - documents MISSING a sortable attribute are NOT dropped from a sorted result;
 *   - they sort LAST in BOTH directions (`:desc` and `:asc` alike — this is not
 *     conventional "nulls last", which would flip), so unlabeled models can never
 *     displace labeled ones at the head whichever way the sort runs;
 *   - an explicit `null` sorts identically to an absent field — including a NESTED one
 *     (`insight: {qualityScore: null}`), measured separately, which is the shape actually
 *     written — so writing the null costs nothing in ordering and additionally unsets;
 *   - a SECOND sort key fully orders that trailing group, which is what lets the
 *     caller tier insight over popularity without inventing a default.
 * A sentinel (say `-1` for every unlabeled model) would be strictly worse: ~718k
 * extra document writes to buy an ordering that already exists, and under `:asc` it
 * would surface the unlabeled block FIRST.
 *
 * ⚠️ Those engine notes are about the SORTABLE attribute, which is `insight.qualityScore`
 * alone. `insight.role` and `insight.styleFamily` are FILTERABLE only — deliberately not
 * sortable, because an ordering over an unordered category has no meaning — so nothing
 * above describes them. What does apply to them is the merge argument: they are written
 * on every document, null included, for the same reason the score is.
 *
 * 🔴 AND `insight.modelVersionId` IS NEITHER SORTABLE NOR FILTERABLE NOR DISPLAYED — it is
 * written and, as of this change, READ BY NOTHING. That is deliberate and it is argued at the
 * projection site in ~/server/search-index/models.search-index.ts, which is where a reader
 * who finds the field arrives; it is not restated here. The merge argument is the one thing
 * that does apply: it is written on every document, null included, for the same reason the
 * other three are.
 */
export function modelInsightProjection(
  versionIds: number[],
  insights: Map<number, ResourceIntentInsight>
): ModelInsightProjection | null {
  let best: ResourceIntentInsight | null = null;
  let bestVersionId = 0;
  for (const versionId of versionIds) {
    const insight = insights.get(versionId);
    if (!insight) continue;
    if (insight.confidence < RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE) continue;
    // Strictly-greater keeps MAX; the second clause is the tiebreak, and it reads off the
    // map KEY rather than `insight.modelVersionId` — `ResourceIntentInsight` does not
    // declare that column, so the key is the only id this function is typed to see.
    const wins =
      best === null ||
      insight.qualityScore > best.qualityScore ||
      (insight.qualityScore === best.qualityScore && versionId < bestVersionId);
    if (wins) {
      best = insight;
      bestVersionId = versionId;
    }
  }
  if (best === null) return null;
  // Copied field-by-field rather than spread, and that is now MORE load-bearing rather than
  // less. `loadResourceInsights` selects the `modelVersionId` column too, so the row object
  // carries one — but the id below is `bestVersionId`, the MAP KEY, and the two are not the
  // same claim: a spread would take the row's own column, which is untyped on
  // `ResourceIntentInsight` (so nothing type-checks it), and would additionally project
  // `confidence`, the internal label-quality judgment. Pinned by a case whose fixture row
  // carries a `modelVersionId` column DISAGREEING with its map key.
  //
  // ⚠️ NO VALUE GUARD HERE, and the asymmetry with the re-ranker is deliberate rather than an
  // oversight. `insightBucket` in ./resource-intent-matcher.service.ts refuses to ACT on a
  // `role` absent from `RESOURCE_INTENT_ROLE_OPTIONS`, because acting on a value this build
  // cannot interpret would evict a candidate. Writing it to the index is the opposite case:
  // the table is deliberately built so a superseded row stays READABLE (see the `stale: false`
  // docstring above), and dropping an out-of-spec label here would blank the axis for every
  // such model until a manual re-label pass finished. Today the two cannot disagree — the
  // write side validates against the same option lists (scripts/label-resource-insights.ts) —
  // but after a spec rename they would, and the index is the side that should keep the value.
  return {
    qualityScore: best.qualityScore,
    role: best.role,
    styleFamily: best.styleFamily,
    modelVersionId: bestVersionId,
  };
}

/**
 * The score-only view of `modelInsightProjection`, byte-for-byte the same number it
 * always returned: the projection applies the same floor and the same MAX, and the
 * tiebreak above cannot move the figure because a tie means the scores are equal.
 *
 * ⚠️ It has NO production caller as of this change — `models.search-index.ts` now takes
 * the whole row — and it is kept for one reason: it is the surface the floor/MAX/null-vs-zero
 * behavioural suite in ~/server/services/__tests__/resource-insight.test.ts was written
 * against, and that suite is coverage of the shared rule rather than of this one-line view.
 *
 * 🔴 DO NOT RESTATE WHO REFERENCES IT — DERIVE IT: `git grep modelInsightQualityScore src`.
 * Two successive drafts of this paragraph got that wrong in two different ways, which is why
 * the instruction replaced the list. The first said "four other files" and named two that
 * never mentioned it. The second named `filterable-attributes.ts` "twice" — and the SAME
 * commit had just retargeted both of those mentions to `modelInsightProjection`, so the
 * correction was false the moment it was written. A sweep that fixes a claim must re-derive
 * it AFTER its own edits, not from the state it remembers.
 *
 * 🔴 `?? null` and not `||` — a genuine `qualityScore: 0` from a version that DID clear
 * the floor must survive as 0, not collapse into the unlabeled null. Pinned by a test.
 *
 * ⚠️ The measured Meilisearch sort/merge behaviour moved one function UP, onto
 * `modelInsightProjection`, when that function took over the rule. It was not deleted —
 * read it there.
 */
export function modelInsightQualityScore(
  versionIds: number[],
  insights: Map<number, ResourceIntentInsight>
): number | null {
  return modelInsightProjection(versionIds, insights)?.qualityScore ?? null;
}
