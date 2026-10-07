import { isGenerationEligible } from '@civitai/shared/generation-eligibility';
import { isGeneratorReady } from '~/shared/generation/generator-readiness';
import { Prisma } from '@prisma/client';
import { chunk, isEqual } from 'lodash-es';
import type { TypoTolerance } from 'meilisearch';
import { type BaseModel } from '~/shared/constants/basemodel.constants';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient as client, updateDocs } from '~/server/meilisearch/client';
import { dbRead } from '~/server/db/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { modelTagCache } from '~/server/redis/caches';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import type { ModelFileMetadata } from '~/server/schema/model-file.schema';
import type { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { SearchIndexContext } from '~/server/search-index/base.search-index';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import {
  MODELS_WITHHELD_ATTRIBUTES,
  modelsDisplayedAttributes,
} from '~/server/search-index/displayed-attributes';
import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { modelsSearchableAttributes } from '~/server/search-index/searchable-attributes';
import { modelVersionPricingSignals } from '@civitai/buzz';
import {
  getModelPaidAccessGates,
  getModelVersionPaidAccessTerms,
} from '~/server/services/paid-access.service';
import { loadResourceInsights, modelInsightProjection } from '~/server/services/resource-insight';
import { modelsSortableAttributes } from '~/server/search-index/sortable-attributes';
import { getValidCreatorMembershipMap } from '~/server/services/creator-program.service';
import {
  anyMetricHidden,
  getMetaMetricPrivacy,
  getUserMetricPrivacyDefaults,
  resolveModelHiddenMetrics,
} from '~/server/utils/model-metric-privacy';
import type { HiddenModelMetrics } from '~/server/utils/model-metric-privacy';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { getCategoryTags } from '~/server/services/system-cache';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { modelSearchIndexSelect } from '../selectors/model.selector';

const READ_BATCH_SIZE = 2000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = READ_BATCH_SIZE;
const INDEX_ID = MODELS_SEARCH_INDEX;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  // The fourth attribute list, and the only one that used to be declared inline here. It is an
  // explicit WHITELIST standing in for Meili's `["*"]` default, so widening it is a safety change
  // — the reasoning, the measurements and the freeze are in ./searchable-attributes.ts.
  // 🔴 The module export is passed STRAIGHT THROUGH, with no local copy, for the reason the
  // displayed list below gives: a local can be mutated between its declaration and the call, so a
  // guard that pins the declaration is not pinning what reaches the engine. That hole was measured
  // on this very list three times over — a `.push` on the next line, a spread at the call site,
  // and a helper taking the array as a parameter, each leaving a fully green suite.
  if (
    JSON.stringify(modelsSearchableAttributes) !== JSON.stringify(settings.searchableAttributes)
  ) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      modelsSearchableAttributes
    );
    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  const sortableAttributes = [...modelsSortableAttributes];

  // Meilisearch stores sorted.
  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  // Creator Controls privacy boundary — the list, and why withholding `sortMetrics` matters, now
  // live in ./displayed-attributes.ts so that this writer and the admin apply route cannot drift.
  // 🔴 This runs ONLY from `reset()`, against `<index>_NEW`, and that job is `UNRUNNABLE_JOB_CRON`,
  // so editing the list does NOT change what a live index returns. To narrow a LIVE index use
  // `src/pages/api/admin/temp/apply-models-index-displayed-attributes.ts`.
  // 🔴 The module export is passed straight through — no local copy. A local one could be mutated
  // between its declaration and this call, which re-opened the leak once and passed every test.
  // ⚠️ That alone is NOT what makes this safe, and an earlier version of this comment claimed it
  // was: the export is handed out by reference, so mutating IT has the same effect and a wider
  // blast radius. What makes it safe is that ./displayed-attributes.ts FREEZES the export. Read
  // that file before changing either side.
  if (JSON.stringify(modelsDisplayedAttributes) !== JSON.stringify(settings.displayedAttributes)) {
    const displayedAttributesTask = await index.updateDisplayedAttributes(
      modelsDisplayedAttributes
    );
    console.log('onIndexSetup :: displayedAttributesTask created', displayedAttributesTask);
  }

  const rankingRules = [
    'sort',
    'attribute',
    'metrics.thumbsUpCount:desc',
    'words',
    'proximity',
    'exactness',
  ];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  if (
    // Meilisearch stores sorted.
    JSON.stringify(modelsFilterableAttributes.sort()) !==
    JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      modelsFilterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  const typoTolerance: TypoTolerance = {
    enabled: true,
    minWordSizeForTypos: {
      oneTypo: 12,
      twoTypos: 16,
    },
    disableOnAttributes: [],
    disableOnWords: [],
  };

  if (
    // Meilisearch stores sorted.
    !isEqual(settings.typoTolerance, typoTolerance)
  ) {
    const updateTypoToleranceTask = await index.updateTypoTolerance(typoTolerance);
    console.log('onIndexSetup :: updateTypoToleranceTask created', updateTypoToleranceTask);
  }
};

type Model = Prisma.ModelGetPayload<{
  select: typeof modelSearchIndexSelect;
}>;
type PullDataResult = {
  models: Model[];
  tags: Awaited<ReturnType<typeof modelTagCache.fetch>>;
  cosmetics: Awaited<ReturnType<typeof getCosmeticsForEntity>>;
  images: ImagesForModelVersions[];
};

type VersionMetricRow = {
  generationCount: number;
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
};

// Nested per-version metrics ship in `displayedAttributes`, so they must obey the
// same model-level hide flags as the card — otherwise the raw hidden number leaks.
// The search-index version selector carries no earned/tipped (buzz) field, so only
// downloads + generations are maskable here.
function maskHiddenVersionMetrics<T extends VersionMetricRow | undefined>(
  metrics: T,
  hidden: HiddenModelMetrics
) {
  if (!metrics) return metrics;
  return {
    ...metrics,
    downloadCount: hidden.downloads ? null : metrics.downloadCount,
    generationCount: hidden.generations ? null : metrics.generationCount,
  };
}

const transformData = async ({ models, tags, cosmetics, images }: PullDataResult) => {
  const modelCategories = await getCategoryTags('model');
  const modelCategoriesIds = modelCategories.map((category) => category.id);

  // Creator Controls metric privacy: store which model-level metrics are hidden so
  // the search card can render the "hidden" notice. Effective only while the owner
  // holds a valid CP membership; the real metrics/rank stay in the doc so sort order
  // is unchanged (only the displayed number is omitted on the card). This is a
  // precomputed shared doc, so a membership lapse reverts to visible on the next
  // reindex rather than instantly.
  const ownerIds = [...new Set(models.map((m) => m.user.id))];
  const ownerSettingsRows = ownerIds.length
    ? await dbRead.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, settings: true },
      })
    : [];
  const ownerSettingsMap = new Map<number, unknown>(
    ownerSettingsRows.map((o) => [o.id, o.settings])
  );
  const membershipCandidates = new Set<number>();
  for (const m of models) {
    const metaHidden = getMetaMetricPrivacy(m.meta);
    const defHidden = getUserMetricPrivacyDefaults(ownerSettingsMap.get(m.user.id));
    if (anyMetricHidden(metaHidden) || anyMetricHidden(defHidden))
      membershipCandidates.add(m.user.id);
  }
  const membershipMap = await getValidCreatorMembershipMap([...membershipCandidates]);

  const modelIds = models.map((m) => m.id);
  const paidAccessGates = await getModelPaidAccessGates(modelIds);

  const versionIds = models.flatMap((m) => m.modelVersions.map((v) => v.id));
  const paidAccessTerms = await getModelVersionPaidAccessTerms(versionIds);

  // Suitability labels are VERSION-level and this index is MODEL-level, so these get
  // collapsed to one score per model below. Batched over the whole read window like
  // every other auxiliary lookup in this function.
  //
  // ⚠️ This adds one query per read batch, over a table that currently holds ~9,900
  // rows against the ~718k documents being rebuilt — so the `in` list is wide and the
  // result set is tiny. It is not free, but it is bounded by `READ_BATCH_SIZE`, not by
  // the corpus.
  //
  // 🔴 FAIL-SOFT, AND THE CATCH IS THE POINT. `ResourceInsight` is applied BY HAND per
  // environment (its migration says so), so in any environment where that has not
  // happened this read throws `P2021` on EVERY batch. Unguarded, that failure does not
  // degrade the score — it takes the whole batch down: `processSearchIndexTask` scores the
  // batch `'error'` and it fails after its retries — a range batch's ids are dropped as
  // `update()` advances `setLastUpdate`, and a targeted batch's are re-queued only to fail
  // again next run — so published models stay out of the index for as long as the read
  // keeps throwing, with `console.error` lines as the only symptom. An optional ordering
  // refinement must never be able to do that.
  //
  // The empty Map falls through to the same `null` -> cleared path an unlabeled model
  // takes, which is already correct. ⚠️ Deliberately broader than `isMissingTableError`
  // in `app-access.service.ts` / `isUndefinedTable` in `app-storage.service.ts`, for the
  // same reason the matcher's copy of this catch is: this read refines an ordering rather
  // than deciding access, so there is no silent zero to generate — every model is still
  // indexed, just without a score. The cost of the breadth is that a permanent fault
  // degrades quietly, which is why it logs on every occurrence rather than once.
  let insights: Awaited<ReturnType<typeof loadResourceInsights>>;
  try {
    insights = await loadResourceInsights(versionIds);
  } catch (error) {
    insights = new Map();
    console.error(
      'transformData :: loadResourceInsights failed; indexing this batch WITHOUT insight labels',
      error
    );
  }

  const indexReadyRecords = models
    .map((modelRecord) => {
      const {
        user,
        modelVersions,
        hashes,
        allowNoCredit,
        allowCommercialUse,
        allowDerivatives,
        allowDifferentLicense,
        meta,
        ...model
      } = modelRecord;
      const metrics = modelRecord.metrics[0] ?? {};

      const [version] = modelVersions;
      if (!version) return null;

      const { files, ...restVersion } = version;

      const eligible = (x: (typeof modelVersions)[number], covered: boolean | undefined) =>
        isGenerationEligible({
          covered,
          coveredLive: x.generationCoverage?.covered,
          baseModel: x.baseModel,
          modelType: model.type,
          flags: x.flags,
        });

      const canGenerate = modelVersions.some((x) => eligible(x, x.generationCoverage?.covered));
      // What `canGenerate` becomes when the staged rule takes over — the same composition over the
      // view's other column. Transitional: delete it, and its filterable entries, at the cutover,
      // when `covered` answers this on its own.
      const canGenerateNext = modelVersions.some((x) =>
        eligible(x, x.generationCoverage?.coveredNext)
      );
      const cannotPromote = (meta as ModelMeta | null)?.cannotPromote;

      const category = tags[model.id]?.tags?.find(({ id }) => modelCategoriesIds.includes(id));

      const hidden = resolveModelHiddenMetrics({
        modelMeta: meta,
        userSettings: ownerSettingsMap.get(user.id),
        isOwnerOrModerator: false,
        hasValidMembership: membershipMap.get(user.id) ?? false,
      });
      const realDownloadCount = metrics?.downloadCount ?? 0;
      const realTippedAmountCount = metrics?.tippedAmountCount ?? 0;

      // The winning version's WHOLE label row — `qualityScore`, `role`, `styleFamily` — plus
      // the id of the version it came from, chosen by MAX `qualityScore` over this model's
      // labeled versions that clear the promote confidence floor, ties broken on the lowest
      // version id; `null` when none qualifies. The rule, the alternatives considered and the
      // tiebreak argument are in `modelInsightProjection`'s docstring.
      //
      // 🔴 ONE CALL, ONE ROW — DO NOT SPLIT THIS INTO A PER-AXIS LOOKUP. The three axes
      // must describe the SAME version: taking the score from the best-scoring version and
      // the role from any other produces a document whose axes describe different
      // resources, so a purpose filter matches a model on a role no version of it that
      // scored well actually has. Every field is individually well-formed, so nothing
      // downstream — not the index, not a consumer, not a reviewer reading one line —
      // can see it. That is why the projection returns a row instead of three numbers.
      //
      // ⚠️ THAT COHERENCE IS WITHIN `insight` ONLY, and this document carries a SECOND,
      // DIFFERENT answer to "which version does this speak for": `version.*` below is
      // flattened from `const [version] = modelVersions` — the FIRST version in
      // `{ index: 'asc' }` order — while `insight.*` comes from the highest-scoring one above
      // the promote floor. The two routinely select different versions, and both are
      // filterable (`version.baseModel` is in ./filterable-attributes.ts), so a query like
      // `insight.role = "style" AND version.baseModel = "SDXL 1.0"` can match a model whose
      // role came from one version and whose base model came from another.
      //
      // 🔴 AND THAT MISMATCH IS NOT OPT-IN — A LIVE, MANDATORY CLAUSE ON THE SINGULAR
      // `version.baseModel` ALREADY SHIPS ON `/search/models`, A PAGE A PURPOSE FILTER WOULD LIVE ON.
      // ⚠️ An earlier version of this paragraph claimed the opposite — "today's only consumer
      // filters on the ARRAY form `versions.baseModel` rather than `version.baseModel`, so
      // nothing currently ANDs the two" — and that was FALSE. `src/pages/search/models.tsx`
      // builds `NOT (nsfwLevel IN [...] AND version.baseModel IN [...])` into the `filters`
      // array it hands `<BrowsingLevelFilter indexKey="models" filters={filters} />`; that
      // forwards to `ApplyCustomFilter`, which runs the array through `joinFilterClauses`
      // (`src/components/Search/search-filters.ts` — parenthesise each clause, join with
      // ` AND `) and into `useConfigure`. The clause is unconditional, so the predicate is on
      // EVERY `/search/models` request. The page does ALSO expose a `versions.baseModel`
      // refinement widget, which is where the array form in the retracted claim came from —
      // the two coexist, and reading only the widget is how the singular one was missed.
      //
      // So the two are un-ANDed on that page today for one reason only: the page reads no
      // `insight.*` yet. The
      // FIRST `insight.*` filter added to that page
      // inherits a cross-version `version.*` predicate whether its author asks for one or not,
      // and the disagreement probability rises with a model's version count — which correlates
      // with maturity, i.e. with whatever outcome such a filter is being judged on.
      //
      // 🔴 WHAT A CONSUMER SHOULD DO ABOUT IT, now that the winning id IS projected: do not
      // assume the existing `version.*` keys agree with `insight.*`, and do not try to AND
      // them into agreement — `version.*` is flattened from a DIFFERENT version and no filter
      // expression can reconcile them. Instead treat `insight.modelVersionId` as the id the
      // `insight.*` axes speak for, and resolve any version-level fact a purpose query needs
      // (base model, availability, generation coverage) against THAT id — from `versions[]` on
      // the hit or from Postgres — rather than against `version.*`. For a measurement rather
      // than a filter, post-stratify on `insight.modelVersionId == version.id` to quantify the
      // disagreement instead of inheriting it silently. ⚠️ Doing any of this from the browser
      // needs the field READABLE first, which it is not — see the note at the key below.
      //
      // `version.*` itself is left as-is rather than reconciled: it is the card-display
      // version and predates all of this.
      //
      // 🔴 THE NULL IS WRITTEN, NOT OMITTED, AND THE DIFFERENCE IS A STALE-SCORE BUG.
      // An earlier version of this omitted the key on `null`, on the measured ground that
      // a missing sortable attribute and an explicit null sort identically. They do — but
      // sorting was the wrong property to check, because every live write is a MERGE:
      // `updateDocs` -> `index.updateDocuments` -> `PUT /indexes/<uid>/documents`, which
      // add-or-updates top-level fields. So on a document that ALREADY carries a score,
      // omitting the key leaves the old value in place.
      //
      // Measured against v1.15.0, both arms: PUTting `{insight:{qualityScore:null}}` over
      // an existing 0.9 moved that document out of the sort head and the stored document
      // read back as `{qualityScore: null}`; the control — a PUT with no `insight` key at
      // all — left `{qualityScore: 0.1}` intact. And a nested null groups with the absent
      // documents in BOTH sort directions, so writing it costs nothing in ordering.
      //
      // Without this, a retracted label (`stale = true`, a re-label below the confidence
      // floor, or a deleted version) leaves its old score and role in the index, and any
      // filter or sort on them would still see it.
      const insightProjection = modelInsightProjection(
        modelVersions.map((v) => v.id),
        insights
      );

      return {
        ...model,
        // All four keys written unconditionally — see the merge argument above. `?? null`
        // and never `?? 0`: a version can legitimately be judged 0 with high confidence,
        // and `?.qualityScore ?? null` keeps that 0 while still clearing an absent label.
        //
        // 🔴 `modelVersionId` IS WRITE-ONLY TODAY — NO SEARCH PATH CAN RETURN IT, AND THAT IS
        // RECORDED HERE ON PURPOSE SO THE NEXT READER DOES NOT FILE IT AS DEAD CODE. The
        // top-level `insight` key is withheld from `modelsDisplayedAttributes` (see
        // ./displayed-attributes.ts) and `attributesToRetrieve` can only narrow WITHIN the
        // displayed set, so it cannot re-admit a withheld attribute: no search response
        // serialises this field. (That narrowing claim is ENGINE-MEASURED, not inferred — on a
        // local Meilisearch v1.54.0, with `displayedAttributes: ["*"]` a request for
        // `["id","insight.modelVersionId"]` returns the field, so the instrument can see it,
        // while with `displayedAttributes: ["id","name"]` the same request returns `{"id":1}`
        // and a filter on the attribute is a 400. ⚠️ v1.54.0 is a LATER engine than the v1.15.0
        // the other measurements in this file and ./displayed-attributes.ts cite.) It is also
        // neither filterable nor sortable, so it is not even reachable as a per-document oracle
        // the way `insight.qualityScore` and the two axes are. Written by nothing else, read by
        // nothing at all.
        //
        // 🔴 CLOSURE RESTS ON A FOURTH LIST, AND AN EARLIER VERSION OF THIS COMMENT ATTRIBUTED
        // IT TO ONLY THREE ABSENCES. `modelsSearchableAttributes` — the explicit whitelist in
        // ./searchable-attributes.ts, applied near the top of `onIndexSetup` in this file; read
        // it there rather than from a copy here — is the fourth, and it is a whitelist rather
        // than a default: swap it for Meili's `["*"]` and the field becomes reachable by
        // free-text query. Measured on a local engine: with the whitelist, `q=42` returns 0
        // hits; with `["*"]`, `q=42` returns 1.
        //
        // What that would buy an attacker is a MEMBERSHIP oracle, not a value leak — the hit
        // body still omits `insight`, because displayed-attribute withholding is a separate
        // mechanism, so the answer is "which model's winning version is 42", one guess at a
        // time. That is the same shape and the same accepted class as the filterable oracle
        // argued above, and it is equally true of the three PRE-EXISTING `insight.*` leaves, so
        // this is NOT new exposure introduced by projecting the id. What was wrong was the
        // completeness of the enumeration. The fourth list is machine-checked in
        // ./__tests__/models-index-insight-projection.test.ts, alongside the other three and by
        // the same means — it is imported, like them.
        //
        // ⚠️ THAT PARITY IS NEW, AND IT COST THREE ESCAPED MUTANTS TO GET. This list used to be a
        // function-local literal in `onIndexSetup` while the other three were exported constants,
        // and the guard on it was correspondingly bespoke: membership assertions read the
        // DECLARATION, which is not what reaches the engine, so a `searchableAttributes.push('*',
        // …)` on the next line and an `updateSearchableAttributes([...searchableAttributes, '*',
        // …])` at the call site each declared exactly what those assertions forbid and each
        // passed a fully green suite. Patching that with a function-scoped member-access ban plus
        // a reference ledger then left a THIRD escape, because a scope-bounded ban always has an
        // adjacent scope: a module-level helper taking the array as a parameter and pushing onto
        // it kept every `onIndexSetup` count clean while the engine received `['name',
        // 'user.username', 'hashes', 'triggerWords', '*', 'insight.modelVersionId']`. The list
        // was therefore hoisted to ./searchable-attributes.ts and frozen there, and the guard is
        // now the displayed list's proven one verbatim: pin the write ARGUMENT, and ban a local
        // binding of the name outright. With no local there is nothing to mutate between a
        // declaration and the write, which closes the class rather than one shape of it.
        //
        // WHY WRITE IT ANYWAY. It records WHICH VERSION THE INDEX DECIDED FOR at reset time,
        // and that fact is NOT recoverable from Postgres afterwards: the labels move
        // (`scripts/label-resource-insights.ts` rewrites rows), the `stale` flag moves, and the
        // promote floor (`RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE`) moves — so re-running the
        // rule later answers for the label state of LATER, not of the document. Without the id,
        // the `version.*` vs `insight.*` disagreement argued above is not merely unfixed, it is
        // UNMEASURABLE: a study cannot post-stratify on something no document carries. And the
        // cost of adding it now is one more leaf on a write that is already happening, against a
        // second authorisation-gated full reset later — `filterableAttributes` genuinely rebuilds
        // facet data, so that reset is not a formality. Same cost asymmetry that justified
        // projecting `role`/`styleFamily` at all.
        //
        // 🔴 MAKING IT READABLE IS A LATER, SEPARATE DECISION — NEITHER ROUTE IS APPROVED, AND
        // DO NOT TAKE EITHER AS A DRIVE-BY. (a) DISPLAY the leaf: remove `insight` from
        // `MODELS_WITHHELD_ATTRIBUTES` / add it to the displayed list — which would expose the
        // whole `insight` object, score included, because both withholding mechanisms key on the
        // TOP-LEVEL attribute, so there is no "just this leaf" version of this route. (b)
        // FILTER-ORACLE it: add `insight.modelVersionId` to ./filterable-attributes.ts — which
        // widens the existing per-document oracle (argued in ./displayed-attributes.ts) to
        // reveal which of a model's versions scored highest, i.e. a signal about internal
        // labels, for anyone holding the browser-published search key. The approved payload is
        // filterable `insight.role` + `insight.styleFamily` and nothing more. Both routes are
        // pinned shut by ./__tests__/models-index-insight-projection.test.ts, which asserts this
        // leaf is absent from all four lists — if one of those assertions is in your way, that
        // is the decision, not an obstacle.
        insight: {
          qualityScore: insightProjection?.qualityScore ?? null,
          role: insightProjection?.role ?? null,
          styleFamily: insightProjection?.styleFamily ?? null,
          modelVersionId: insightProjection?.modelVersionId ?? null,
        },
        earlyAccessDeadline: paidAccessGates.get(model.id)?.earlyAccessDeadline ?? null,
        hasActivePaidAccess: paidAccessGates.get(model.id)?.gated ?? false,
        nsfwLevel: parseBitwiseBrowsingLevel(model.nsfwLevel),
        lastVersionAtUnix: model.lastVersionAt?.getTime() ?? model.createdAt.getTime(),
        user,
        category: {
          id: category?.id,
          name: category?.name,
        },
        permissions: {
          allowNoCredit,
          allowCommercialUse,
          allowDerivatives,
          allowDifferentLicense,
          minor: modelRecord.minor,
          sfwOnly: modelRecord.sfwOnly,
        },
        version: {
          ...restVersion,
          metrics: maskHiddenVersionMetrics(restVersion.metrics[0], hidden),
          hashes: restVersion.hashes.map((hash) => hash.hash),
          hashData: restVersion.hashes.map((hash) => ({ hash: hash.hash, type: hash.hashType })),
          settings: restVersion.settings as RecommendedSettingsSchema,
          baseModel: restVersion.baseModel as BaseModel,
        },
        versions: modelVersions.map(
          ({
            generationCoverage,
            files,
            hashes,
            settings,
            metrics: vMetrics,
            usageControl,
            ...x
          }) => ({
            ...x,
            // Keeps the column's name but holds readiness — the loaded-only filter reads this.
            generatorLoaded: isGeneratorReady({ generatorLoaded: x.generatorLoaded, usageControl }),
            pricing: modelVersionPricingSignals({ paidAccess: paidAccessTerms.get(x.id) ?? null }),
            metrics: maskHiddenVersionMetrics(vMetrics[0], hidden),
            hashes: hashes.map((hash) => hash.hash),
            hashData: hashes.map((hash) => ({ hash: hash.hash, type: hash.hashType })),
            canGenerate: isGenerationEligible({
              covered: generationCoverage?.covered,
              coveredLive: generationCoverage?.covered,
              baseModel: x.baseModel,
              modelType: model.type,
              flags: x.flags,
            }),
            canGenerateNext: isGenerationEligible({
              covered: generationCoverage?.coveredNext,
              coveredLive: generationCoverage?.covered,
              baseModel: x.baseModel,
              modelType: model.type,
              flags: x.flags,
            }),
            settings: settings as RecommendedSettingsSchema,
            baseModel: x.baseModel as BaseModel,
          })
        ),
        triggerWords: [
          ...new Set(modelVersions.flatMap((modelVersion) => modelVersion.trainedWords)),
        ],
        fileFormats: [
          ...new Set(
            modelVersions
              .flatMap((modelVersion) =>
                modelVersion.files.map((x) => (x.metadata as ModelFileMetadata)?.format)
              )
              .filter(isDefined)
          ),
        ],
        hashes: hashes.map((hash) => hash.hash.toLowerCase()),
        tags:
          tags[model.id]?.tags.map((x) => ({
            id: x.id,
            name: x.name,
          })) ?? [],
        // DISPLAYED metrics — hidden ones masked to null (never leak the real number
        // to the search hit). Sort order is preserved via `sortMetrics` below.
        metrics: {
          ...metrics,
          downloadCount: hidden.downloads ? null : realDownloadCount,
          tippedAmountCount: hidden.buzz ? null : realTippedAmountCount,
        },
        rank: {
          downloadCount: hidden.downloads ? null : realDownloadCount,
          thumbsUpCount: metrics.thumbsUpCount ?? 0,
          commentCount: metrics.commentCount ?? 0,
          collectedCount: metrics.collectedCount ?? 0,
          tippedAmountCount: hidden.buzz ? null : realTippedAmountCount,
        },
        // SORT-ONLY: REAL values, excluded from `displayedAttributes` (see onIndexSetup) so they
        // are never returned to clients. NOT sortable yet: `sortableAttributes` only reach a live
        // index through the manual index-reset job, so until a reset ships, the search sort options
        // stay on `metrics.*` (see `modelsSortableAttributes` and
        // src/components/Search/parsers/model.parser.ts). Once one has, add these two back to
        // `modelsSortableAttributes` and repoint those options — then most-downloaded /
        // most-tipped keeps the true order even when the displayed number is masked.
        sortMetrics: {
          downloadCount: realDownloadCount,
          tippedAmountCount: realTippedAmountCount,
        },
        hiddenMetrics: hidden,
        canGenerate,
        canGenerateNext,
        cannotPromote,
        cosmetic: cosmetics[model.id] ?? null,
      };
    })
    // Removes null models that have no versionIDs
    .filter(isDefined);

  const indexRecordsWithImages = models
    .map((modelRecord) => {
      const { modelVersions, ...model } = modelRecord;

      if (!modelVersions.length) {
        return null;
      }

      // Keep images for the newest version of each distinct base model — not just the
      // latest version — so base-model-filtered cards can show a matching version's
      // cover. The latest version goes first, so images[0] stays the primary cover.
      const coveredBaseModels = new Set<string>();
      const coveredVersionIds: number[] = [];
      for (const version of modelVersions) {
        if (coveredBaseModels.has(version.baseModel)) continue;
        coveredBaseModels.add(version.baseModel);
        coveredVersionIds.push(version.id);
      }

      const modelImages = coveredVersionIds.flatMap((versionId) =>
        images.filter(
          (image) =>
            image.modelVersionId === versionId && image.availability !== Availability.Unsearchable
        )
      );

      return {
        id: model.id,
        images: modelImages,
      };
    })
    // Removes null models that have no versionIDs
    .filter(isDefined);

  return {
    indexReadyRecords,
    indexRecordsWithImages,
  };
};

export type ModelSearchIndexRecord = Awaited<
  ReturnType<typeof transformData>
>['indexReadyRecords'][number] &
  Awaited<ReturnType<typeof transformData>>['indexRecordsWithImages'][number];

// Build the same card-ready records the Meili index holds, but straight from the
// DB for a handful of ids — so callers (e.g. the official-models pin in the
// resource picker) don't depend on those docs being present/fresh in Meili.
// Reuses transformData so the shape stays identical to a search hit.
export async function getModelSearchIndexRecords(ids: number[]): Promise<ModelSearchIndexRecord[]> {
  if (!ids.length) return [];

  const models = await dbRead.model.findMany({
    select: modelSearchIndexSelect,
    where: { id: { in: ids }, status: ModelStatus.Published },
  });
  if (!models.length) return [];

  const batchIds = models.map((m) => m.id);
  const [cosmetics, tags] = await Promise.all([
    getCosmeticsForEntity({ ids: batchIds, entity: 'Model' }),
    modelTagCache.fetch(batchIds),
  ]);
  const modelVersionIds = models.flatMap((m) => m.modelVersions.map((v) => v.id));
  const imagesCache = await imagesForModelVersionsCache.fetch(modelVersionIds);
  const images = Object.values(imagesCache).flatMap((x) => x.images.slice(0, 10));

  const { indexReadyRecords, indexRecordsWithImages } = await transformData({
    models,
    tags,
    cosmetics,
    images,
  });

  const imagesById = new Map(indexRecordsWithImages.map((r) => [r.id, r.images]));
  const byId = new Map(
    indexReadyRecords.map((r) => [
      r.id,
      withheldStripped({ ...r, images: imagesById.get(r.id) ?? [] }),
    ])
  );
  // Preserve the caller's id order.
  return ids.map((id) => byId.get(id)).filter(isDefined) as ModelSearchIndexRecord[];
}

/**
 * 🔴 THE WHOLE POINT OF THIS FUNCTION'S DOCSTRING — "the shape stays identical to a search
 * hit" — AND IT WAS NOT TRUE. `displayedAttributes` governs only the MEILISEARCH read path,
 * so this DB-direct path returned every attribute that whitelist exists to withhold, and the
 * records go straight to `transformModelHits` (a bare `{...item}` spread) and out of
 * `model.getResourceSelect`, a `publicProcedure` with no `.output()` schema.
 *
 * So an unauthenticated caller received, for every official-pinned model in the resource
 * picker's default state:
 *   - `sortMetrics` — the REAL download and tipped-amount values, whose own comment in
 *     `transformData` says they are "excluded from `displayedAttributes` ... so they are
 *     never returned to clients". For a creator who hid those numbers via Creator Controls
 *     this is exactly the leak `./displayed-attributes.ts` was written to close, reached by
 *     the one path that whitelist cannot see. PRE-EXISTING, not introduced by the insight work.
 *   - `insight` — an internal, unvalidated per-model LLM quality judgment.
 *
 * Driven off `MODELS_WITHHELD_ATTRIBUTES` rather than a local list so the two cannot drift:
 * that export is the deliberate record of what a document carries and a hit must not, and it
 * is frozen. Safe by construction — anything a consumer legitimately reads off a hit must
 * already survive Meilisearch withholding it, since that narrowing is live on `models_v9`.
 *
 * Exported for the same reason `prepareModelsBatches` below is: so a test can drive it
 * directly. It guards a privacy boundary, so it is worth a behavioural test rather than a
 * source-text one — `getModelSearchIndexRecords` itself needs a Prisma payload, several
 * caches and a live DB. Tested in `src/server/__tests__/models-displayed-attributes.test.ts`,
 * which owns this boundary, because the strip protects all five withheld attributes and not
 * only the newest one.
 */
export function withheldStripped<T extends Record<string, unknown>>(record: T): T {
  const out = { ...record };
  for (const attr of MODELS_WITHHELD_ATTRIBUTES) delete out[attr];
  return out;
}

/**
 * Hoisted and exported so the delta scan's paging can be driven by a test.
 *
 * The update pass walks the set by KEYSET (`id > lastId ORDER BY id`) rather than by OFFSET.
 * The set is re-evaluated on every page and its membership moves while the scan runs — an edit
 * that unpublishes a model, or flips it to Unsearchable, takes a row out from under the cursor
 * and shifts every later OFFSET page down, so a model that was eligible for the whole scan is
 * silently never indexed. Ordering the OFFSET query would not have helped: ids are immutable and
 * a keyset cursor only moves forward, which is what makes the skip unreachable rather than rare.
 *
 * A row that ENTERS the set below the cursor is deliberately left for the next run: the `now`
 * that `createSearchIndexUpdateProcessor` hands to `setLastUpdate` is captured before this
 * function is called, so anything edited mid-scan falls inside the next window.
 */
export const prepareModelsBatches = async (
  { db, logger }: SearchIndexContext,
  lastUpdatedAt?: Date
) => {
  const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
      SELECT MIN(id) as "startId", MAX(id) as "endId" FROM "Model"
      WHERE status = ${ModelStatus.Published}::"ModelStatus"
          AND availability != ${Availability.Unsearchable}::"Availability"
      ${
        lastUpdatedAt
          ? Prisma.sql`
        AND "createdAt" >= ${lastUpdatedAt}
      `
          : Prisma.sql``
      };
    `;

  const { startId, endId } = data[0];
  logger(
    `PrepareBatches :: StartId: ${startId}, EndId: ${endId}. Last Updated at ${lastUpdatedAt}`
  );

  const updateIds: number[] = [];

  if (lastUpdatedAt) {
    let lastId = 0;

    while (true) {
      const ids = await db.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Model"
        WHERE status = ${ModelStatus.Published}::"ModelStatus"
            AND availability != ${Availability.Unsearchable}::"Availability"
            AND "updatedAt" >= ${lastUpdatedAt}
            AND id > ${lastId}
        ORDER BY id
        LIMIT ${READ_BATCH_SIZE};
        `;

      if (!ids.length) {
        break;
      }

      lastId = ids[ids.length - 1].id;
      updateIds.push(...ids.map((x) => x.id));

      if (ids.length < READ_BATCH_SIZE) {
        break;
      }
    }
  }

  return {
    batchSize: READ_BATCH_SIZE,
    startId,
    endId,
    updateIds,
  };
};

export const modelsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 25, // Avoids hoggging too much memory.
  prepareBatches: prepareModelsBatches,
  pullData: async ({ db, logger }, batch) => {
    const batchLogKey =
      batch.type === 'update'
        ? `Update ${batch.ids.length} items`
        : `${batch.startId} - ${batch.endId}`;
    logger(`PullData :: Pulling data for batch`, batchLogKey);
    const models = await db.model.findMany({
      select: modelSearchIndexSelect,
      where: {
        status: ModelStatus.Published,
        availability: {
          not: Availability.Unsearchable,
        },
        id:
          batch.type === 'update'
            ? {
                in: batch.ids,
              }
            : {
                gte: batch.startId,
                lte: batch.endId,
              },
      },
    });

    logger(`PullData :: Pulled models`, batchLogKey);

    const results: PullDataResult = {
      models,
      tags: {},
      cosmetics: {},
      images: [],
    };

    if (models.length === 0) return results;

    const pullBatches = chunk(models, 500);
    const tasks: Task[] = [];
    for (const batch of pullBatches) {
      const batchIds = batch.map((m) => m.id);
      tasks.push(async () => {
        logger(`PullData :: Pull cosmetics`, batchLogKey);
        const cosmetics = await getCosmeticsForEntity({
          ids: batchIds,
          entity: 'Model',
        });
        logger(`PullData :: Pulled cosmetics`, batchLogKey);
        Object.assign(results.cosmetics, cosmetics);
      });

      tasks.push(async () => {
        logger(`PullData :: Pull tags`, batchLogKey);
        const tags = await modelTagCache.fetch(batchIds);
        logger(`PullData :: Pulled tags`, batchLogKey);
        Object.assign(results.tags, tags);
      });

      const modelVersionIds = batch.flatMap((m) => m.modelVersions.map((m) => m.id));
      const versionBatches = chunk(modelVersionIds, 500);
      for (const versionBatch of versionBatches) {
        tasks.push(async () => {
          logger(`PullData :: Pull images`, batchLogKey);
          const imagesCache = await imagesForModelVersionsCache.fetch(versionBatch);
          const images = Object.values(imagesCache).flatMap((x) => x.images.slice(0, 10));
          logger(`PullData :: Pulled images`, batchLogKey);

          results.images.push(...images);
        });
      }
    }
    await limitConcurrency(tasks, 2);

    logger(`PullData :: Finished pulling data for batch`, batchLogKey);

    return results;
  },
  transformData,
  pushData: async ({ indexName }, data) => {
    const { indexReadyRecords, indexRecordsWithImages } = data as {
      indexReadyRecords: any[];
      indexRecordsWithImages: any[];
    };

    const records = [...indexReadyRecords, ...indexRecordsWithImages];

    if (records.length > 0) {
      await updateDocs({
        indexName,
        documents: records,
        batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
      });
    }

    return;
  },
});
