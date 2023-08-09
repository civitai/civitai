import { client } from '~/server/meilisearch/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import {
  MetricTimeframe,
  ModelHashType,
  ModelStatus,
  Prisma,
  PrismaClient,
  SearchIndexUpdateQueueAction,
} from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import {
  getOrCreateIndex,
  onSearchIndexDocumentsCleanup,
  waitForTasksWithRetries,
} from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { isDefined } from '~/utils/type-guards';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { getCategoryTags } from '~/server/services/system-cache';

const RATING_BAYESIAN_M = 3.5;
const RATING_BAYESIAN_C = 10;

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 50;
const INDEX_ID = 'models';
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

  const searchableAttributes = [
    'name',
    'user.username',
    'category.id',
    'hashes',
    'tags',
    'triggerWords',
  ];

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
    'metrics.commentCount',
    'metrics.favoriteCount',
    'metrics.downloadCount',
    'metrics.rating',
    'metrics.ratingCount',
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
    'attribute',
    'metrics.weightedRating:desc',
    'words',
    'proximity',
    'sort',
    'exactness',
    'typo',
  ];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  const filterableAttributes = [
    'hashes',
    'nsfw',
    'type',
    'checkpointType',
    'tags',
    'modelVersion.baseModel',
    'status',
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
};

const onFetchItemsToIndex = async ({
  db,
  whereOr,
  indexName,
  ...queryProps
}: {
  db: PrismaClient;
  indexName: string;
  whereOr?: Prisma.Enumerable<Prisma.ModelWhereInput>;
  skip?: number;
  take?: number;
}) => {
  const modelCategories = await getCategoryTags('model');
  const modelCategoriesIds = modelCategories.map((category) => category.id);

  const offset = queryProps.skip || 0;
  console.log(
    `onFetchItemsToIndex :: fetching starting for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    ' filters:',
    whereOr
  );
  const models = await db.model.findMany({
    take: READ_BATCH_SIZE,
    ...queryProps,
    select: {
      id: true,
      name: true,
      type: true,
      nsfw: true,
      status: true,
      createdAt: true,
      lastVersionAt: true,
      publishedAt: true,
      locked: true,
      earlyAccessDeadline: true,
      mode: true,
      checkpointType: true,
      // Joins:
      user: {
        select: userWithCosmeticsSelect,
      },
      modelVersions: {
        orderBy: { index: 'asc' },
        take: 1,
        select: {
          id: true,
          earlyAccessTimeFrame: true,
          createdAt: true,
          modelVersionGenerationCoverage: { select: { workers: true } },
          trainedWords: true,
          baseModel: true,
          baseModelType: true,
        },
        where: {
          status: ModelStatus.Published,
        },
      },
      tagsOnModels: { select: { tag: { select: { id: true, name: true } } } },
      hashes: {
        select: modelHashSelect,
        where: {
          hashType: ModelHashType.SHA256,
          fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
        },
      },
      metrics: {
        select: {
          commentCount: true,
          favoriteCount: true,
          downloadCount: true,
          rating: true,
          ratingCount: true,
        },
        where: {
          timeframe: MetricTimeframe.AllTime,
        },
      },
    },
    where: {
      status: ModelStatus.Published,
      OR: whereOr,
    },
  });

  console.log(
    `onFetchItemsToIndex :: fetching complete for ${indexName} range:`,
    offset,
    offset + READ_BATCH_SIZE - 1,
    'filters:',
    whereOr
  );

  // Avoids hitting the DB without data.
  if (models.length === 0) {
    return {
      indexReadyRecords: [],
      indexRecordsWithImages: [],
    };
  }

  const modelVersionIds = models.flatMap((m) => m.modelVersions).map((m) => m.id);
  const images = !!modelVersionIds.length
    ? await getImagesForModelVersion({
        modelVersionIds,
        imagesPerVersion: 10,
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

  // Get tags for each image:
  const imagesWithTags = images.map((image) => {
    const imageTags = tagsOnImages
      .filter((tagOnImage) => tagOnImage.imageId === image.id)
      .map((tagOnImage) => tagOnImage.tag.name);
    return {
      ...image,
      tags: imageTags,
    };
  });

  const indexReadyRecords = models
    .map((modelRecord) => {
      const { user, modelVersions, tagsOnModels, hashes, ...model } = modelRecord;

      const metrics = modelRecord.metrics[0] || {};

      const weightedRating =
        (metrics.rating * metrics.ratingCount + RATING_BAYESIAN_M * RATING_BAYESIAN_C) /
        (metrics.ratingCount + RATING_BAYESIAN_C);

      const [modelVersion] = modelVersions;

      if (!modelVersion) {
        return null;
      }

      const category = tagsOnModels.find((tagOnModel) =>
        modelCategoriesIds.includes(tagOnModel.tag.id)
      );

      return {
        ...model,
        user,
        category,
        modelVersion,
        triggerWords: [
          ...new Set(modelVersions.flatMap((modelVersion) => modelVersion.trainedWords)),
        ],
        hashes: hashes.map((hash) => hash.hash.toLowerCase()),
        tags: tagsOnModels.map((tagOnModel) => tagOnModel.tag.name),
        metrics: {
          ...metrics,
          weightedRating,
        },
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
        (image) => image.modelVersionId === modelVersion.id
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

const onUpdateQueueProcess = async ({ db, indexName }: { db: PrismaClient; indexName: string }) => {
  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: { type: INDEX_ID, action: SearchIndexUpdateQueueAction.Update },
  });

  console.log(
    'onUpdateQueueProcess :: A total of ',
    queuedItems.length,
    ' have been updated and will be re-indexed'
  );

  const batchCount = Math.ceil(queuedItems.length / READ_BATCH_SIZE);

  const itemsToIndex: Awaited<ReturnType<typeof onFetchItemsToIndex>> = {
    indexReadyRecords: [],
    indexRecordsWithImages: [],
  };

  for (let batchNumber = 0; batchNumber < batchCount; batchNumber++) {
    const batch = queuedItems.slice(
      batchNumber * READ_BATCH_SIZE,
      batchNumber * READ_BATCH_SIZE + READ_BATCH_SIZE
    );

    const itemIds = batch.map(({ id }) => id);

    const { indexReadyRecords, indexRecordsWithImages } = await onFetchItemsToIndex({
      db,
      indexName,
      whereOr: {
        id: {
          in: itemIds,
        },
      },
    });

    itemsToIndex.indexReadyRecords.push(...indexReadyRecords);
    itemsToIndex.indexRecordsWithImages.push(...indexRecordsWithImages);
  }

  return itemsToIndex;
};

const onIndexUpdate = async ({
  db,
  lastUpdatedAt,
  indexName = INDEX_ID,
}: SearchIndexRunContext) => {
  if (!client) return;

  // Confirm index setup & working:
  await onIndexSetup({ indexName });

  // Cleanup documents that require deletion:
  // Always pass INDEX_ID here, not index name, as pending to delete will
  // always use this name.
  await onSearchIndexDocumentsCleanup({ db, indexName: INDEX_ID });

  const modelTasks: EnqueuedTask[] = [];

  if (lastUpdatedAt) {
    // Only if this is an update (NOT a reset or first run) will we care for queued items:

    // Update whatever items we have on the queue.
    // Do it on batches, since it's possible that there are far more items than we expect:
    const {
      indexReadyRecords: updateIndexReadyRecords,
      indexRecordsWithImages: updateIndexRecordsWithImages,
    } = await onUpdateQueueProcess({
      db,
      indexName,
    });

    if (updateIndexReadyRecords.length > 0) {
      const updateBaseTasks = await client
        .index(indexName)
        .updateDocumentsInBatches(updateIndexReadyRecords, MEILISEARCH_DOCUMENT_BATCH_SIZE);

      console.log('onIndexUpdate :: base tasks for updated items have been added');
      modelTasks.push(...updateBaseTasks);
    }

    if (updateIndexRecordsWithImages.length > 0) {
      const updateImageTasks = await client
        .index(indexName)
        .updateDocumentsInBatches(updateIndexRecordsWithImages, MEILISEARCH_DOCUMENT_BATCH_SIZE);

      console.log('onIndexUpdate :: image tasks for updated items have been added');

      modelTasks.push(...updateImageTasks);
    }
  }

  // Now, we can tackle new additions
  let offset = 0;
  while (true) {
    const { indexReadyRecords, indexRecordsWithImages } = await onFetchItemsToIndex({
      db,
      indexName,
      skip: offset,
      whereOr: lastUpdatedAt
        ? [
            {
              createdAt: {
                gt: lastUpdatedAt,
              },
            },
            {
              updatedAt: {
                gt: lastUpdatedAt,
              },
            },
          ]
        : undefined,
    });

    if (indexReadyRecords.length === 0 && indexRecordsWithImages.length === 0) {
      break;
    }

    const baseTasks = await client
      .index(indexName)
      .updateDocumentsInBatches(indexReadyRecords, MEILISEARCH_DOCUMENT_BATCH_SIZE);

    console.log('onIndexUpdate :: base tasks have been added');

    const imagesTasks = await client
      .index(indexName)
      .updateDocumentsInBatches(indexRecordsWithImages, MEILISEARCH_DOCUMENT_BATCH_SIZE);

    console.log('onIndexUpdate :: image tasks have been added');

    modelTasks.push(...baseTasks);
    modelTasks.push(...imagesTasks);

    offset += indexReadyRecords.length;
  }

  const waitForTaskTime = Date.now();
  console.log('onIndexUpdate :: start waitForTasks');
  await waitForTasksWithRetries(modelTasks.map((x) => x.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks', '- time:', Date.now() - waitForTaskTime);
};

export const modelsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
