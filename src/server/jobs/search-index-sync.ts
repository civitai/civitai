import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { client } from '~/server/meilisearch/client';
import { ModelStatus } from '@prisma/client';
import { EnqueuedTask } from 'meilisearch';

export const searchIndexSync = createJob('search-index-sync', '33 4 * * *', async () => {
  // Get all models and add to meilisearch index
  if (!client) return;

  const allTasks = await Promise.all([prepareModelIndex()]);
});

const READ_BATCH_SIZE = 1000;
async function prepareModelIndex() {
  if (!client) return;

  let offset = 0;
  const modelTasks: EnqueuedTask[] = [];
  const allTasks: EnqueuedTask[] = [];
  while (true) {
    const models = await dbWrite.model.findMany({
      skip: offset,
      take: READ_BATCH_SIZE,
      select: {
        id: true,
        name: true,
        type: true,
        nsfw: true,
        poi: true,
        checkpointType: true,
        locked: true,
        underAttack: true,
        earlyAccessDeadline: true,
        mode: true,
        allowNoCredit: true,
        allowCommercialUse: true,
        allowDerivatives: true,
        allowDifferentLicense: true,
        userId: true,
      },
      where: {
        status: ModelStatus.Published,
      },
    });

    if (models.length === 0) break;
    offset += models.length;

    modelTasks.push(await client.index('models_new').addDocuments(models));
    allTasks.push(
      await client.index('all_new').addDocuments(
        models.map((m) => ({
          id: `model:${m.id}`,
          name: m.name,
          type: m.type,
          nsfw: m.nsfw,
        }))
      )
    );
  }

  await client.waitForTasks(modelTasks.map((x) => x.taskUid));
  const swapTask = await client.swapIndexes([{ indexes: ['models', 'models_new'] }]);
  await client.waitForTask(swapTask.taskUid);
  await client.deleteIndex('models_new');

  return allTasks;
}
