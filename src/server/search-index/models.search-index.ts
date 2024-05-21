import { client, updateDocs } from '~/server/meilisearch/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { Availability, MetricTimeframe, ModelHashType, ModelStatus, Prisma } from '@prisma/client';
import { isEqual } from 'lodash';
import { MODELS_SEARCH_INDEX, ModelFileType } from '~/server/common/constants';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { TypoTolerance } from 'meilisearch';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { isDefined } from '~/utils/type-guards';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { getCategoryTags } from '~/server/services/system-cache';
import { ModelFileMetadata } from '~/server/schema/model-file.schema';
import { getModelVersionsForSearchIndex } from '../selectors/modelVersion.selector';
import { getUnavailableResources } from '../services/generation/generation.service';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '../common/enums';
import { RecommendedSettingsSchema } from '~/server/schema/model-version.schema';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';

const RATING_BAYESIAN_M = 3.5;
const RATING_BAYESIAN_C = 10;

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 10000;
const INDEX_ID = MODELS_SEARCH_INDEX;
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;

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
    'metrics.thumbsUpCount',
    'createdAt',
    'metrics.commentCount',
    'metrics.favoriteCount',
    'metrics.downloadCount',
    'metrics.rating',
    'metrics.ratingCount',
    'metrics.collectedCount',
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
    'hashes',
    'nsfwLevel',
    'type',
    'checkpointType',
    'tags.name',
    'user.username',
    'version.baseModel',
    'user.username',
    'status',
    'category.name',
    'canGenerate',
    'fileFormats',
    'lastVersionAtUnix',
    'versions.hashes',
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

const modelSelect = {
  id: true,
  name: true,
  type: true,
  nsfwLevel: true,
  status: true,
  createdAt: true,
  lastVersionAt: true,
  publishedAt: true,
  locked: true,
  earlyAccessDeadline: true,
  mode: true,
  checkpointType: true,
  availability: true,
  // Joins:
  user: {
    select: userWithCosmeticsSelect,
  },
  modelVersions: {
    select: getModelVersionsForSearchIndex,
    orderBy: { index: 'asc' as const },
    where: {
      status: ModelStatus.Published,
      availability: {
        not: Availability.Unsearchable,
      },
    },
  },
  tagsOnModels: { select: { tag: { select: { id: true, name: true } } } },
  hashes: {
    select: modelHashSelect,
    where: {
      fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
      hashType: { notIn: ['AutoV1'] as ModelHashType[] },
    },
  },
  metrics: {
    select: {
      commentCount: true,
      favoriteCount: true,
      thumbsUpCount: true,
      downloadCount: true,
      rating: true,
      ratingCount: true,
      collectedCount: true,
      tippedAmountCount: true,
    },
    where: {
      timeframe: MetricTimeframe.AllTime,
    },
  },
};

type Model = Prisma.ModelGetPayload<{
  select: typeof modelSelect;
}>;

const tagsOnImagesSelect = {
  imageId: true,
  tag: {
    select: {
      id: true,
      name: true,
    },
  },
};

type TagsOnImages = Prisma.TagsOnImageGetPayload<{
  select: typeof tagsOnImagesSelect;
}>;

const transformData = async ({
  models,
  cosmetics,
  images,
  tagsOnImages,
}: {
  models: Model[];
  cosmetics: Awaited<ReturnType<typeof getCosmeticsForEntity>>;
  images: Awaited<ReturnType<typeof getImagesForModelVersion>>;
  tagsOnImages: TagsOnImages[];
}) => {
  const modelCategories = await getCategoryTags('model');
  const modelCategoriesIds = modelCategories.map((category) => category.id);

  // Get tags for each image:
  const imagesWithTags = images.map((image) => {
    const imageTags = tagsOnImages
      .filter((tagOnImage) => tagOnImage.imageId === image.id)
      .map((tagOnImage) => tagOnImage.tag);

    return {
      ...image,
      tags: imageTags,
    };
  });

  const unavailableGenResources = await getUnavailableResources();

  const indexReadyRecords = models
    .map((modelRecord) => {
      const { user, modelVersions, tagsOnModels, hashes, ...model } = modelRecord;

      const metrics = modelRecord.metrics[0] ?? {};

      const weightedRating =
        (metrics.rating * metrics.ratingCount + RATING_BAYESIAN_M * RATING_BAYESIAN_C) /
        (metrics.ratingCount + RATING_BAYESIAN_C);

      const [version] = modelVersions;

      if (!version) {
        return null;
      }

      const canGenerate = modelVersions.some(
        (x) => x.generationCoverage?.covered && !unavailableGenResources.includes(x.id)
      );

      const category = tagsOnModels.find((tagOnModel) =>
        modelCategoriesIds.includes(tagOnModel.tag.id)
      );

      return {
        ...model,
        nsfwLevel: parseBitwiseBrowsingLevel(model.nsfwLevel),
        lastVersionAtUnix: model.lastVersionAt?.getTime() ?? model.createdAt.getTime(),
        user,
        category: category?.tag,
        version: {
          ...version,
          settings: version.settings as RecommendedSettingsSchema,
          hashes: version.hashes.map((hash) => hash.hash),
        },
        versions: modelVersions.map(({ generationCoverage, files, hashes, settings, ...x }) => ({
          ...x,
          hashes: hashes.map((hash) => hash.hash),
          canGenerate: generationCoverage?.covered && unavailableGenResources.indexOf(x.id) === -1,
          settings: settings as RecommendedSettingsSchema,
        })),
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
        tags: tagsOnModels.map((tagOnModel) => tagOnModel.tag),
        metrics: {
          ...metrics,
          weightedRating,
        },
        rank: {
          downloadCount: metrics?.downloadCount ?? 0,
          favoriteCount: metrics.favoriteCount ?? 0,
          thumbsUpCount: metrics.thumbsUpCount ?? 0,
          commentCount: metrics.commentCount ?? 0,
          ratingCount: metrics.ratingCount ?? 0,
          rating: metrics.rating ?? 0,
          collectedCount: metrics.collectedCount ?? 0,
          tippedAmountCount: metrics.tippedAmountCount ?? 0,
        },
        canGenerate,
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

      const modelImages = imagesWithTags.filter(
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
    logger(`PullData :: Pulling data for batch: ${batch}`);
    const models = await db.model.findMany({
      select: modelSelect,
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

    logger(`PullData :: Pulled models`);

    if (models.length === 0) {
      return {
        models: [],
        cosmetics: {},
        images: [],
        tagsOnImages: [],
      };
    }

    const cosmetics = await getCosmeticsForEntity({
      ids: models.map((m) => m.id),
      entity: 'Model',
    });

    logger(`PullData :: Pulled cosmetics`);

    const modelVersionIds = models.flatMap((m) => m.modelVersions.map((m) => m.id));
    const images = !!modelVersionIds.length
      ? await getImagesForModelVersion({
          modelVersionIds,
          imagesPerVersion: 10,
          browsingLevel: NsfwLevel.PG + NsfwLevel.PG13 + NsfwLevel.R + NsfwLevel.X + NsfwLevel.XXX, // Avoid blocked.
        })
      : [];

    const imageIds = images.map((image) => image.id);
    // Performs a single DB request:
    const tagsOnImages = !imageIds.length
      ? []
      : await db.tagsOnImage.findMany({
          select: {
            imageId: true,
            tag: {
              select: {
                id: true,
                name: true,
              },
            },
          },
          where: {
            imageId: {
              in: imageIds,
            },
          },
        });

    return {
      models,
      cosmetics,
      images,
      tagsOnImages,
    };
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
