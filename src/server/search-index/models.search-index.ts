import { client } from '~/server/meilisearch/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import {
  MetricTimeframe,
  ModelHashType,
  ModelStatus,
  SearchIndexUpdateQueueAction,
} from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { isDefined } from '~/utils/type-guards';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { getCategoryTags } from '~/server/services/system-cache';

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

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'name',
    'user.username',
    'category.id',
    'hashes',
    'tags',
  ]);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'createdAt',
    'rank.ratingAllTimeRank',
    'rank.favoriteCountAllTime',
    'rank.commentCountAllTime',
    'rank.favoriteCountAllTimeRank',
    'rank.ratingCountAllTimeRank',
    'rank.downloadCountAllTimeRank',
    'rank.downloadCountAllTime',
    'metrics.commentCount',
    'metrics.favoriteCount',
    'metrics.downloadCount',
    'metrics.rating',
    'metrics.ratingCount',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  const updateRankingRulesTask = await index.updateRankingRules([
    // TODO.lrojas94: keep playing with ranking rules.
    'attribute',
    'rank.ratingAllTimeRank:asc',
    'rank.downloadCountAllTimeRank:asc',
    'words',
    'typo',
    'proximity',
    'sort',
    'exactness',
  ]);

  console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
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

  let offset = 0;
  const modelTasks: EnqueuedTask[] = [];

  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: { type: INDEX_ID, action: SearchIndexUpdateQueueAction.Update },
  });

  const modelCategories = await getCategoryTags('model');
  const modelCategoriesIds = modelCategories.map((category) => category.id);

  while (true) {
    const fetchStart = Date.now();
    console.log(
      `onIndexUpdate :: fetching starting for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1
    );

    const models = await db.model.findMany({
      skip: offset,
      take: READ_BATCH_SIZE,
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
        rank: {
          select: {
            ratingAllTimeRank: true,
            favoriteCountAllTime: true,
            commentCountAllTime: true,
            favoriteCountAllTimeRank: true,
            ratingCountAllTimeRank: true,
            downloadCountAllTimeRank: true,
            downloadCountAllTime: true,
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
        // if lastUpdatedAt is not provided,
        // this should generate the entirety of the index.
        OR: !lastUpdatedAt
          ? undefined
          : [
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
              {
                id: {
                  in: queuedItems.map(({ id }) => id),
                },
              },
            ],
      },
    });

    console.log(
      `onIndexUpdate :: fetching complete for ${indexName} range:`,
      offset,
      offset + READ_BATCH_SIZE - 1,
      '- time:',
      Date.now() - fetchStart
    );

    // Avoids hitting the DB without data.
    if (models.length === 0) break;

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
        const { metrics, user, modelVersions, tagsOnModels, hashes, ...model } = modelRecord;

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
          hashes: hashes.map((hash) => hash.hash.toLowerCase()),
          tags: tagsOnModels.map((tagOnModel) => tagOnModel.tag.name),
          metrics: {
            // Flattens metric array
            ...(metrics[0] || {}),
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

    offset += models.length;
  }

  const waitForTaskTime = Date.now();
  console.log('onIndexUpdate :: start waitForTasks');
  await client.waitForTasks(modelTasks.map((x) => x.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks', '- time:', Date.now() - waitForTaskTime);
};

export const modelsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  swapIndexName: SWAP_INDEX_ID,
  onIndexUpdate,
  onIndexSetup,
});
