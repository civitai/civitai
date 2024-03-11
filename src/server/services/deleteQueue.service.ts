import { EntityType } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { chunk } from 'lodash-es';
import { isProd } from '~/env/other';

export async function createDeleteQueues({
  entityType,
  ids,
}: {
  entityType: EntityType;
  ids?: number[];
}) {
  if (!ids?.length) return;

  if (!isProd) console.log(`enqueue delete :: ${entityType} :: called with ${ids.length} items`);

  const batches = chunk(ids, 500);
  for (const batch of batches) {
    await dbWrite.$executeRawUnsafe(`
        INSERT INTO "DeleteQueue" ("entityId", "entityType")
        VALUES ${batch.map((entityId) => `(${entityId}, '${entityType}')`).join(', ')}
        ON CONFLICT ("entityId", "entityType") DO NOTHING;
    `);
  }
}
