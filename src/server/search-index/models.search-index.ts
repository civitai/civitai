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
import { modelVersionPricingSignals } from '@civitai/buzz';
import {
  getModelPaidAccessGates,
  getModelVersionPaidAccessTerms,
} from '~/server/services/paid-access.service';
import { loadResourceInsights, modelInsightQualityScore } from '~/server/services/resource-insight';
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

  const searchableAttributes = ['name', 'user.username', 'hashes', 'triggerWords'];

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
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
  // batch `'error'`, the batch is dropped after its retries, and `update()` advances
  // `setLastUpdate` regardless, so up to `READ_BATCH_SIZE` published models are dropped
  // from the index PERMANENTLY, every 15 minutes, with a `console.error` as the only
  // symptom. An optional ordering refinement must never be able to do that.
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
      'transformData :: loadResourceInsights failed; indexing this batch WITHOUT insight scores',
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

      // MAX `qualityScore` over this model's labeled versions that clear the promote
      // confidence floor; `null` when none. The rule and the alternatives considered are
      // in `modelInsightQualityScore`'s docstring.
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
      // floor, or a deleted version) keeps its top-of-pool seeding forever: the row is
      // gone from Postgres, so the re-rank never reaches `insightBucket` and leaves the
      // candidate neutral — which PRESERVES the head position the stale score bought.
      const insightQualityScore = modelInsightQualityScore(
        modelVersions.map((v) => v.id),
        insights
      );

      return {
        ...model,
        insight: { qualityScore: insightQualityScore },
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
