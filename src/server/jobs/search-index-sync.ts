import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { client } from '~/server/meilisearch/client';
import { ModelHashType, ModelStatus } from '@prisma/client';
import { EnqueuedTask } from 'meilisearch';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { ModelFileType } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { swapIndex } from '~/server/meilisearch/util';

export const searchIndexSync = createJob('search-index-sync', '33 4 * * *', async () => {
  // Get all models and add to meilisearch index
  console.log('searchIndexSync :: Starting search-index-sync');
  if (!client) {
    console.log('searchIndexSync :: client is unavailable');
    return;
  }

  const allTasks = await Promise.all([prepareModelIndex()]);
});

// TODO: Bring back to 1000
// TODO: Consider increasing this count. As per MeiliSearch, bigger is better
const READ_BATCH_SIZE = 10;
async function prepareModelIndex() {
  if (!client) return;

  let offset = 0;
  const modelTasks: EnqueuedTask[] = [];
  const allTasks: EnqueuedTask[] = [];
  // TODO: Remove limit condition here. We should fetch until break
  while (offset < READ_BATCH_SIZE) {
    console.log('prepareModelIndex :: fetching models', offset, READ_BATCH_SIZE);
    const models = await dbWrite.model.findMany({
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
      },
    });

    console.log('prepareModelIndex :: models fetched', models);

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

    console.log('prepareModelIndex :: models prepared for indexing', indexReadyModels);

    modelTasks.push(await client.index('models_new').addDocuments(indexReadyModels));

    console.log('prepareModelIndex :: task pushed to queue');

    offset += models.length;
  }

  console.log('prepareModelIndex :: start waitForTasks');
  await client.waitForTasks(modelTasks.map((x) => x.taskUid));
  console.log('prepareModelIndex :: complete waitForTasks');

  await swapIndex('models', 'models_new');

  return allTasks;
}
