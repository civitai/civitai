import { Prisma } from '@prisma/client';
import { chunk, isEqual } from 'lodash-es';
import type { TypoTolerance } from 'meilisearch';
import {
  getBaseModelGenerationSupported,
  type BaseModel,
} from '~/shared/constants/base-model.constants';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient as client, updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { modelTagCache } from '~/server/redis/caches';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import type { ModelFileMetadata } from '~/server/schema/model-file.schema';
import type { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import type { ModelMeta } from '~/server/schema/model.schema';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { getCategoryTags } from '~/server/services/system-cache';
import type { Task } from '~/server/utils/concurrency-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { modelSearchIndexSelect } from '../selectors/model.selector';
import { getUnavailableResources } from '../services/generation/generation.service';

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

  const sortableAttributes = [
    // sort
    'createdAt',
    'id',
    'metrics.collectedCount',
    'metrics.commentCount',
    'metrics.downloadCount',
    'metrics.thumbsUpCount',
    'metrics.tippedAmountCount',
  ];

  // Meilisearch stores sorted.
  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
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

  const filterableAttributes = [
    'availability',
    'canGenerate',
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
    'versions.hashes',
    'versions.id',
    'availability',
    'cannotPromote',
    'poi',
    'minor',
  ];

  if (
    // Meilisearch stores sorted.
    JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      filterableAttributes
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
const transformData = async ({ models, tags, cosmetics, images }: PullDataResult) => {
  const modelCategories = await getCategoryTags('model');
  const modelCategoriesIds = modelCategories.map((category) => category.id);

  const unavailableGenResources = await getUnavailableResources();

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

      const canGenerate = modelVersions.some(
        (x) =>
          x.generationCoverage?.covered &&
          !unavailableGenResources.includes(x.id) &&
          getBaseModelGenerationSupported(x.baseModel, model.type)
      );
      const cannotPromote = (meta as ModelMeta | null)?.cannotPromote;

      const category = tags[model.id]?.tags?.find(({ id }) => modelCategoriesIds.includes(id));

      return {
        ...model,
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
          metrics: restVersion.metrics[0],
          hashes: restVersion.hashes.map((hash) => hash.hash),
          hashData: restVersion.hashes.map((hash) => ({ hash: hash.hash, type: hash.hashType })),
          settings: restVersion.settings as RecommendedSettingsSchema,
          baseModel: restVersion.baseModel as BaseModel,
        },
        versions: modelVersions.map(
          ({ generationCoverage, files, hashes, settings, metrics: vMetrics, ...x }) => ({
            ...x,
            metrics: vMetrics[0],
            hashes: hashes.map((hash) => hash.hash),
            hashData: hashes.map((hash) => ({ hash: hash.hash, type: hash.hashType })),
            canGenerate:
              generationCoverage?.covered &&
              unavailableGenResources.indexOf(x.id) === -1 &&
              getBaseModelGenerationSupported(x.baseModel, model.type),
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
        metrics: {
          ...metrics,
        },
        rank: {
          downloadCount: metrics?.downloadCount ?? 0,
          thumbsUpCount: metrics.thumbsUpCount ?? 0,
          commentCount: metrics.commentCount ?? 0,
          collectedCount: metrics.collectedCount ?? 0,
          tippedAmountCount: metrics.tippedAmountCount ?? 0,
        },
        canGenerate,
        cannotPromote,
        cosmetic: cosmetics[model.id] ?? null,
      };
    })
    // Removes null models that have no versionIDs
    .filter(isDefined);

  const indexRecordsWithImages = models
    .map((modelRecord) => {
      const { modelVersions, ...model } = modelRecord;
      const [modelVersion] = modelVersions;

      if (!modelVersion) {
        return null;
      }

      const modelImages = images.filter(
        (image) =>
          image.modelVersionId === modelVersion.id &&
          image.availability !== Availability.Unsearchable
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

export const modelsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  setup: onIndexSetup,
  maxQueueSize: 25, // Avoids hoggging too much memory.
  prepareBatches: async ({ db, logger }, lastUpdatedAt) => {
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

    const updateIds = [];

    if (lastUpdatedAt) {
      let offset = 0;

      while (true) {
        const ids = await db.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Model"
        WHERE status = ${ModelStatus.Published}::"ModelStatus"
            AND availability != ${Availability.Unsearchable}::"Availability"
            AND "updatedAt" >= ${lastUpdatedAt}
        OFFSET ${offset} LIMIT ${READ_BATCH_SIZE};
        `;

        if (!ids.length) {
          break;
        }

        offset += READ_BATCH_SIZE;
        updateIds.push(...ids.map((x) => x.id));
      }
    }

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
      updateIds,
    };
  },
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
