import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';

// Kept a leaf so a test can read these without loading `~/server/meilisearch/client`, which builds
// pLimit/prom collectors at module load.

// `id` is filterable on every index because the keyset cleanup scan in
// src/server/meilisearch/cleanup.ts pages on it.
export const articlesFilterableAttributes = ['id', 'tags.name', 'user.username', 'nsfwLevel'];

export const bountiesFilterableAttributes = [
  'id',
  'user.username',
  'type',
  'details.baseModel',
  'tags.name',
  'complete',
  'nsfwLevel',
];

export const collectionsFilterableAttributes = ['user.username', 'type', 'nsfwLevel', 'id'];

export const comicsFilterableAttributes = ['id', 'user.username', 'genre', 'nsfwLevel'];

export const imagesFilterableAttributes = [
  'id',
  'createdAtUnix',
  'tagNames',
  'user.username',
  'baseModel',
  'aspectRatio',
  'nsfwLevel',
  'type',
  'toolNames',
  'techniqueNames',
  'flags.promptNsfw',
  'poi',
  'minor',
];

export const modelsFilterableAttributes = [
  'availability',
  'canGenerate',
  'canGenerateNext',
  'category.name',
  'checkpointType',
  'fileFormats',
  'hashes',
  'id',
  'lastVersionAtUnix',
  'nsfwLevel',
  'status',
  'tags.name',
  'type',
  'user.id',
  'user.username',
  'version.baseModel',
  'versions.baseModel',
  'versions.canGenerateNext',
  'versions.generatorLoaded',
  'versions.hashes',
  'versions.id',
  'versions.pricing',
  'cannotPromote',
  'poi',
  'minor',
  'hasActivePaidAccess',
  // Carried so a filter can split the models with a PROMOTABLE label — ≈7,023 of them — from
  // everything else (the labeled-vs-unlabeled arms described below; the M3 retrieval
  // comparison does not split on it — its matcher arm reaches labels through the re-rank's
  // Postgres read). 🔴 That "everything
  // else" side is NOT the unlabeled set: it holds 863 labeled models too, for the reasons
  // enumerated below. Do not describe it as the unlabeled tier.
  // Verified on Meilisearch v1.15.0 that filtering works on this field even though
  // ./displayed-attributes.ts withholds it.
  //
  // 🔴 THE PREDICATE IS `IS NOT NULL` / `IS NULL`, **NOT** `EXISTS` / `NOT EXISTS`, and an
  // earlier version of this comment named the wrong pair. `models.search-index.ts` WRITES
  // `insight: { qualityScore: null, role: null, styleFamily: null, modelVersionId: null }`
  // whenever the projection returns null (it must — omitting a key cannot clear a stale value
  // under PUT merge semantics; see that file). All FOUR nulls come from the SAME branch of the
  // SAME projection, so they can never disagree about whether a model has a usable label.
  // ⚠️ `modelVersionId` is written but is NOT in this list and must not be added — it is
  // unreadable by any search path by design, argued at the projection site. Nothing below
  // describes it; the predicate table is about `insight.qualityScore`.
  // A written null COUNTS AS EXISTING, so once a reset has written every document:
  //   EXISTS       -> every document (useless as a labeled-tier arm)
  //   NOT EXISTS   -> nothing at all (useless as a control arm)
  //   IS NOT NULL  -> models with a PROMOTABLE label — at least one version at or above
  //                   `RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE`   <- the labeled arm
  //   IS NULL      -> everything else                             <- the control arm
  //
  // 🔴 `IS NULL` is NOT "the unlabeled remainder" — an earlier version of this table said so,
  // and a written null has at least FIVE causes: (1) genuinely unlabeled, by design;
  // (2) LABELED but with no version at or above the promote floor (0.3) —
  // `modelInsightProjection` skips sub-floor versions and returns null when none qualify,
  // see ~/server/services/resource-insight.ts; (3) a label-read FAULT —
  // `models.search-index.ts` catches a throw from `loadResourceInsights` and recovers with an
  // empty Map, so EVERY model in that batch writes null, labeled or not, with a
  // `console.error` as the only symptom; (4) the label row is STALE — `loadResourceInsights`
  // filters `stale: false`, so a labeled version whose row has been invalidated reads as
  // absent; (5) the labeled VERSION is not in the projection — `modelSearchIndexSelect`
  // filters `modelVersions` to `status: Published` and `availability != Unsearchable`
  // (~/server/selectors/model.selector.ts), so a qualifying label on a version later
  // unpublished or flipped Unsearchable never reaches `modelInsightProjection`.
  //
  // Cause 2 happens in completely normal operation. Causes 4 and 5 both MEASURE ZERO as of
  // 2026-10-03 (no stale rows; no non-Published/Unsearchable labeled versions), but they are
  // live mechanisms, not hypotheticals — creators unpublish routinely, so cause 5 will occur.
  // 🔴 That is why cause 2 must not be read in reverse: "null AND labeled" does NOT imply
  // "every one of that model's labels is sub-floor". Causes 4 and 5 produce the same null
  // from an ABOVE-floor label.
  //
  // Measured 2026-10-03 on the replica (figures, not arithmetic): of the 9,900 `ResourceInsight`
  // label rows, 1,265 (12.78%) sit below the floor, leaving 863 of the 7,886 models carrying at
  // least one label (10.9%) with no qualifying version. Those cut in OPPOSITE directions — as
  // control-arm contamination it is DERIVED (not measured) at ≈0.12% of the index corpus,
  // negligible; as labeled-arm coverage it EXCLUDES 10.9% of labeled models, and that exclusion
  // is the promote floor doing its deliberate job, not a defect. No absolute document count is
  // given here on purpose: an earlier version of this paragraph stated one under the "measured"
  // attribution when it had in fact been derived from a stale denominator.
  //
  // So `IS NOT NULL` is the right labeled arm FOR A RETRIEVAL QUESTION — it is exactly the
  // population the feature acts on. 🔴 It is NOT the right frame for a LABEL-QUALITY read: it
  // is a confidence-truncated sample that omits precisely the weakest 10.9% of labeled
  // MODELS (863 of the 7,886 carrying a label), i.e. the ones most likely to be wrong, so it
  // biases any quality headline HIGH. 🔴 MODELS, not label rows — an earlier version of this
  // sentence said "10.9% of labels", and the omitted ROW share is that figure under neither
  // reading: those 863 fully-excluded models hold 887 rows (8.96% of the 9,900
  // `ResourceInsight` label rows), while ALL sub-floor rows number 1,265 (12.78% of the same
  // 9,900). And the model-level frame cannot express the 378 sub-floor rows that are the
  // difference between those two (1,265 less the 887): they sit on models that qualify via
  // ANOTHER version, so those rows are dropped from the SCORE while their model stays in the
  // sample. Those 863 are
  // also index-UNREACHABLE — in the index a written null is indistinguishable from unlabeled —
  // so they can only be sampled from Postgres. And the floor itself was argued for ONE job:
  // its own docstring (`RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE`,
  // ~/server/services/resource-insight.ts) weighs the promote side only and says it "says
  // nothing about the demote side, which is why that side has its own constant". Defining a
  // STUDY ARM is a third use with no argument of its own. Which frame applies depends on the
  // study's question, and that is not settled here.
  //
  // 🔴 POSITIVE CONTROL ANY RUN OF THESE ARMS MUST PERFORM: assert an `IS NOT NULL` count of
  // ≈7,023 (the 7,886 labeled models minus the 863 with no qualifying version) before trusting
  // any result. Under a TOTAL cause-3 fault `IS NOT NULL` returns NOTHING and `IS NULL`
  // returns the entire index — which presents as "the two arms show no difference", i.e. a
  // null result rather than an error. A reassuring zero is indistinguishable from a probe
  // wired to nothing. The control is deliberately scoped to a total fault: cause 3 is
  // PER-BATCH, so a partial fault still leaves thousands of labeled documents and passes any
  // loose threshold.
  //
  // 🔴 NO COMMITTED RUNNER IMPLEMENTS THESE ARMS — the labeled-vs-unlabeled split by
  // `IS NOT NULL` / `IS NULL` above. The M3 study DOES now carry a retrieval comparison
  // (`scripts/eval-resource-intent-retrieval.ts`, run from the gold-set runner), but its
  // arms are different ones: the shipped matcher (popularity seed + label re-rank) against
  // that seed alone, both over the same gate filter, neither filtering on this attribute's
  // nullness, and its own positive control reads `ResourceInsight` rows, not this index.
  // So the `IS NOT NULL` control above still belongs to whatever labeled-vs-unlabeled
  // comparison gets built.
  //
  // Measured on v1.15.0 over a mixed fixture (labeled / written-null / key-absent): EXISTS
  // returned 5 of 7 including every written null, NOT EXISTS returned only the 2 whose key
  // was absent, and `IS NOT NULL` returned the labeled rows plus the key-absent ones — which
  // is why the pair above is only correct once every document carries the key, i.e. AFTER a
  // full reset.
  //
  // 🔴 PRE-RESET, NO PREDICATE ON THIS ATTRIBUTE ISOLATES THE LABELED SET — not a single one
  // and not any combination of them, so do not go hunting for a cleverer filter. Key-absence
  // does NOT mean unlabeled. It means "this document has not been rewritten since the field
  // shipped", i.e. it tracks DOCUMENT-REWRITE HISTORY, which is orthogonal to labeled-ness and
  // if anything ANTI-correlated with it: a label write causes no document rewrite at all.
  // `scripts/label-resource-insights.ts` contains no search-index enqueue of any kind and
  // never touches `Model.updatedAt`, and `prepareModelsBatches` in ./models.search-index.ts
  // re-pulls only models satisfying `updatedAt >= lastUpdatedAt` — which a label write does
  // not move. So labeling is precisely the event that does NOT trigger a rewrite.
  //
  // 🔴 AND THE PRE-RESET DIRECTION IS THE OPPOSITE OF THE INTUITIVE ONE — read it off the
  // fixture measured in the paragraph above, not off intuition. That fixture recorded
  // `IS NOT NULL` returning the labeled rows PLUS the key-absent ones, so on v1.15.0
  // `IS NULL` matches ONLY key-present-and-null, and `IS NOT NULL`, being its negation,
  // SWEEPS IN EVERY KEY-ABSENT DOCUMENT. Pre-reset almost every document is key-absent (a
  // label write rewrites nothing — just above). Therefore, pre-reset:
  //   IS NOT NULL  -> ≈ THE ENTIRE INDEX. Not a near-empty set.
  //   IS NULL      -> a SMALL set: only documents rewritten since the field shipped that
  //                   received a null.
  // and the labeled-but-never-rewritten models land in `IS NOT NULL` together with
  // everything else. So neither arm isolates them — the heading above, reached from the
  // other side.
  //
  // ⚠ An earlier version of this paragraph had that exactly inverted ("`IS NOT NULL` …
  // near-empty, while `IS NULL` sweeps the rest of the labeled population into the
  // control"), contradicting the fixture paragraph above. It was not merely misplaced: it is
  // TRUE of the two-clause route (`EXISTS AND … IS NOT NULL` against
  // `IS NULL OR NOT EXISTS`), which reduces to key-present-with-value and so IS near-empty
  // pre-reset. That route was deliberately deleted, and the sentence was carried across to
  // the bare predicates, where it inverts. Reinstate neither.
  //
  // 🔴 Three wrong actions the inverted reading enables, which is why this is spelled out.
  // (a) This list CAN be applied to a live index with NO reset, via the admin route named at
  // the bottom of this comment — do that, run the positive control, and `IS NOT NULL` comes
  // back as the whole index rather than ≈7,023; because the old text promised near-empty, a
  // count two orders of magnitude too high reads as "the reset must already have run" instead
  // of "key-absent documents are sitting in my labeled arm". (b) The same trap once #5359
  // merges and a labeling pass runs: a reader expecting ≈7,023 gets the whole index. (c) It
  // destroys the reset-has-run check immediately below.
  //
  // ✅ COROLLARY, and the operationally useful one: `IS NULL`'s OWN COUNT is a clean
  // discriminator for whether the full reset has run — a small number before, ≈ the entire
  // index minus the ≈7,023 labeled arm after. (Stated relationally on purpose, for the same
  // reason the measured paragraph above gives no absolute document count; a search with an
  // empty filter returns the index total to compare it against.) The inverted sentence
  // claimed `IS NULL` was already large pre-reset, which made the two states look
  // indistinguishable.
  //
  // The heading's "not any combination of them" is load-bearing and survives all of the
  // above: labeled models are spread across all THREE cells — key-absent,
  // key-present-with-value, and key-present-null (causes 2–5) — so no boolean expression over
  // {EXISTS, NOT EXISTS, IS NULL, IS NOT NULL} carves the labeled set out of any of them.
  //
  // #5359 changes the first half of that — once it merges, a label write WILL enqueue the
  // model — but the arms are still only clean after a full reset, since documents written
  // before the field shipped stay key-absent until one runs.
  //
  // ⚠ Added in the SAME change as the sortable entry, and the reason first given for that
  // was WRONG: it said "both lists are written only by `onIndexSetup` from `reset()`".
  // That holds for `sortableAttributes` and NOT for this list —
  // src/pages/api/admin/temp/apply-models-index-filterable-attributes.ts applies THIS list
  // to the live index with no reset, and there is no sortable equivalent of that route.
  //
  // The decision stands on the corrected argument: a reset writes both lists into the
  // `_NEW` index at setup, so riding the reset this change already requires is FREE,
  // whereas deferring it means paying that route's own full facet rebuild later. So the
  // asymmetry is a reason to land it now, not a reason the claim was harmless.
  'insight.qualityScore',
  // The two MEANING axes — the arc's actual goal, which `insight.qualityScore` is not.
  // Their vocabularies are `RESOURCE_INTENT_ROLE_OPTIONS` and
  // `RESOURCE_INTENT_STYLE_FAMILY_OPTIONS` (~/server/schema/resource-intent.schema.ts) —
  // named rather than counted, because a count restated here goes silently wrong the first
  // time an option is added. Both are written from the SAME version row the score came from
  // (`modelInsightProjection`, ~/server/services/resource-insight.ts). Quality answers "how
  // good"; these answer "what FOR", which is the question a purpose query asks.
  //
  // ⚠️ `category.name` above is the OTHER filterable answer to "what is this FOR", and the
  // next person to add a purpose filter will meet both. They are not interchangeable:
  // `category.name` is a MODEL-level creator-assigned tag drawn from the category tag set,
  // whereas `insight.role` is a VERSION-level machine label behind a confidence floor,
  // projected from one winning version. Pick deliberately; ANDing them intersects two
  // different authorities on the same question and silently narrows the pool.
  //
  // 🔴 FILTERABLE ONLY, AND DELIBERATELY NOT SORTABLE — do not "complete the set" by
  // adding them to ./sortable-attributes.ts. They are unordered categories, so a
  // `role:desc` would order alphabetically and read as meaningful ranking; Meilisearch
  // accepts a sort on any declared sortable attribute without complaint, so that mistake
  // is silent. A purpose query would want an EQUALITY filter (`insight.role = "style"`),
  // which is exactly what this list buys.
  //
  // 🔴 NO READER: nothing filters on either field — the resource-intent matcher and the
  // M3 study both read labels from Postgres. A document only ACQUIRES these fields when it
  // is rewritten, so a model whose document predates its label carries a null role. ⚠️ A future filter that ANDs the role
  // with the ARRAY form `versions.baseModel IN [...]` inherits the cross-version caveat in
  // ./models.search-index.ts: the role may come from a version on a different base model
  // than the versions it then expands to.
  //
  // 🔴 ⚠️ DO NOT RE-DERIVE THAT AS "THE LISTS ONLY REACH A LIVE INDEX THROUGH A RESET" — a
  // draft of this very entry said exactly that, and it is the claim the ⚠️ paragraph beside
  // the score entry above was written to RETRACT. THIS list has
  // src/pages/api/admin/temp/apply-models-index-filterable-attributes.ts, which applies it to
  // the live index with no reset; only `sortableAttributes` and `displayedAttributes` are
  // reset-only. The separability argument does not need the false half, so it no longer
  // carries it — the DOCUMENTS are what wait for a rewrite, not the settings.
  //
  // ⚠️ The null semantics are the score's, verbatim: `models.search-index.ts` writes
  // `role: null` / `styleFamily: null` on every model with no qualifying version, because
  // a PUT merge cannot clear a key it omits. So the `IS NOT NULL` / `IS NULL` arms and
  // the FIVE causes of a written null enumerated above the score entry apply unchanged to
  // these two — including that `IS NULL` is NOT "the unlabeled remainder". One difference
  // worth knowing: a null here and a null on the score are the SAME null, written in the
  // same branch from the same projection returning null, so the three can never disagree
  // about whether a model has a usable label.
  'insight.role',
  'insight.styleFamily',
];

export const toolsFilterableAttributes = ['id', 'type', 'company'];

export const usersFilterableAttributes = ['id', 'username'];

export const filterableAttributesByIndex = {
  [ARTICLES_SEARCH_INDEX]: articlesFilterableAttributes,
  [BOUNTIES_SEARCH_INDEX]: bountiesFilterableAttributes,
  [COLLECTIONS_SEARCH_INDEX]: collectionsFilterableAttributes,
  [COMICS_SEARCH_INDEX]: comicsFilterableAttributes,
  [IMAGES_SEARCH_INDEX]: imagesFilterableAttributes,
  [MODELS_SEARCH_INDEX]: modelsFilterableAttributes,
  [TOOLS_SEARCH_INDEX]: toolsFilterableAttributes,
  [USERS_SEARCH_INDEX]: usersFilterableAttributes,
} as const;
