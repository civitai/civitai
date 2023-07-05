import { client } from '~/server/meilisearch/client';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { MetricTimeframe, ModelHashType, ModelStatus } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { isDefined } from '~/utils/type-guards';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';

const READ_BATCH_SIZE = 200;
const INDEX_ID = 'models';
const SWAP_INDEX_ID = `${INDEX_ID}_NEW`;
const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(indexName);
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'name',
    'user.username',
    'tags',
    'hashes',
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
    'words',
    'typo',
    'proximity',
    'attribute',
    'rank.ratingAllTimeRank:asc',
    'rank.downloadCountAllTimeRank:asc',
    'sort',
    'exactness',
  ]);

  console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);

  await client.waitForTasks([
    updateSearchableAttributesTask.taskUid,
    sortableFieldsAttributesTask.taskUid,
    updateRankingRulesTask.taskUid,
  ]);

  console.log('onIndexSetup :: all tasks completed');
};

const onIndexUpdate = async ({
  db,
  lastUpdatedAt,
  indexName = INDEX_ID,
}: SearchIndexRunContext) => {
  if (!client) return;

  // Confirm index setup & working:
  await onIndexSetup({ indexName });

  let offset = 0;
  const modelTasks: EnqueuedTask[] = [];

  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: { type: INDEX_ID },
  });

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
        description: true,
        // Joins:
        user: { select: simpleUserSelect },
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
        })
      : [];

    const indexReadyModels = models
      .map((modelRecord) => {
        const { metrics, user, modelVersions, tagsOnModels, hashes, ...model } = modelRecord;

        const [modelVersion] = modelVersions;

        if (!modelVersion) {
          return null;
        }

        const modelImages = images.filter((image) => image.modelVersionId === modelVersion.id);

        return {
          ...model,
          user,
          images: modelImages,
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

    modelTasks.push(await client.index(indexName).updateDocuments(indexReadyModels));

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
