import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { client } from '~/server/meilisearch/client';
import { ModelHashType, ModelModifier, ModelStatus } from '@prisma/client';
import { EnqueuedTask } from 'meilisearch';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { ModelFileType } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';

export const searchIndexSync = createJob('search-index-sync', '33 4 * * *', async () => {
  // Get all models and add to meilisearch index
  if (!client) return;

  const allTasks = await Promise.all([prepareModelIndex()]);
});

// TODO: Bring back to 1000
const READ_BATCH_SIZE = 10;
async function prepareModelIndex() {
  if (!client) return;

  let offset = 0;
  const modelTasks: EnqueuedTask[] = [];
  const allTasks: EnqueuedTask[] = [];
  // TODO: Remove limit condition here. We should fetch until break
  while (offset < READ_BATCH_SIZE) {
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

    modelTasks.push(await client.index('models_new').addDocuments(indexReadyModels));

    offset += models.length;
  }

  await client.waitForTasks(modelTasks.map((x) => x.taskUid));
  const swapTask = await client.swapIndexes([{ indexes: ['models', 'models_new'] }]);
  await client.waitForTask(swapTask.taskUid);
  await client.deleteIndex('models_new');

  return allTasks;
}
