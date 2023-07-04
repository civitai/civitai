import { client } from '~/server/meilisearch/client';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { ModelHashType, ModelStatus } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { isDefined } from '~/utils/type-guards';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';

const READ_BATCH_SIZE = 100;
const INDEX_NAME = 'models';
const onIndexSetup = async () => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(INDEX_NAME);
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const updateSearchableAttributesTask = await index.updateSearchableAttributes([
    'name',
    'description',
    'tags',
    'username',
    'hashes',
  ]);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  /**
   * TODO: Add other sortable fields such as:
   * - Rank
   * - Likes
   * - Comments count
   */
  const sortableFieldsAttributesTask = await index.updateSortableAttributes(['creation_date']);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  await client.waitForTasks([
    updateSearchableAttributesTask.taskUid,
    sortableFieldsAttributesTask.taskUid,
  ]);

  console.log('onIndexSetup :: all tasks completed');
};

const onIndexUpdate = async ({ db, lastUpdatedAt }: SearchIndexRunContext) => {
  if (!client) return;

  // Confirm index setup & working:
  await onIndexSetup();

  let offset = 0;
  const modelTasks: EnqueuedTask[] = [];

  // TODO: confirm if the queue can grow big enough that querying without a limit can be a concern.
  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: {
      type: INDEX_NAME,
    },
  });

  // TODO: Remove limit condition here. We should fetch until break
  while (offset < READ_BATCH_SIZE) {
    console.log('onIndexUpdate :: fetching models', offset, READ_BATCH_SIZE);
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

    console.log('onIndexUpdate :: models fetched', models);

    // Avoids hitting the DB without models data.
    if (models.length === 0) break;

    const modelVersionIds = models.flatMap((m) => m.modelVersions).map((m) => m.id);
    const images = !!modelVersionIds.length
      ? await getImagesForModelVersion({
          modelVersionIds,
        })
      : [];

    const indexReadyModels = models
      .map((modelRecord) => {
        const { user, modelVersions, tagsOnModels, hashes, ...model } = modelRecord;

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
        };
      })
      // Removes null models that have no versionIDs
      .filter(isDefined);

    console.log('onIndexUpdate :: models prepared for indexing', indexReadyModels);

    modelTasks.push(await client.index(`${INDEX_NAME}`).updateDocuments(indexReadyModels));

    console.log('onIndexUpdate :: task pushed to queue');

    offset += models.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await client.waitForTasks(modelTasks.map((x) => x.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const modelsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_NAME,
  onIndexUpdate,
});
