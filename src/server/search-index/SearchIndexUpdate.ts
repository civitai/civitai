import { SearchIndexUpdateQueueAction } from '@prisma/client';
import { chunk } from 'lodash';
import { dbWrite } from '~/server/db/client';

export abstract class SearchIndexUpdate {
  static async queueUpdate({
    indexName,
    items,
  }: {
    indexName: string;
    items: Array<{ id: number; action?: SearchIndexUpdateQueueAction }>;
  }) {
    if (!items.length) return;

    console.log(
      `createSearchIndexUpdateProcessor :: ${indexName} :: queueUpdate :: Called with ${items.length} items`
    );

    const batches = chunk(items, 500);
    for (const batch of batches) {
      await dbWrite.$executeRawUnsafe(`
        INSERT INTO "SearchIndexUpdateQueue" ("type", "id", "action")
        VALUES ${batch
          .map(
            ({ id, action }) =>
              `('${indexName}', ${id}, '${action ?? SearchIndexUpdateQueueAction.Update}')`
          )
          .join(', ')}
        ON CONFLICT ("type", "id", "action") DO NOTHING;
    `);
    }
  }
}
