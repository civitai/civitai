import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { addToQueue, checkoutQueue } from '~/server/redis/queues';

async function queueUpdate({
  indexName,
  items,
}: {
  indexName: string;
  items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>;
}) {
  for (const type of Object.keys(SearchIndexUpdateQueueAction)) {
    const typeItems = items.filter((i) => i.action === type).map(({ id }) => id);
    if (!typeItems.length) continue;
    await addToQueue(`${indexName}:${type}`, typeItems);
  }
}

async function getQueue(indexName: string, action: SearchIndexUpdateQueueAction) {
  return await checkoutQueue(`${indexName}:${action}`);
}

async function clearQueue(indexName: string) {
  for (const type of Object.keys(SearchIndexUpdateQueueAction)) {
    const queue = await checkoutQueue(`${indexName}:${type}`);
    await queue.commit();
  }
}

export const SearchIndexUpdate = {
  queueUpdate,
  getQueue,
  clearQueue,
};
