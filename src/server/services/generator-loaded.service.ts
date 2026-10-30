import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { bustResourceResidency } from '~/server/services/resource-residency.service';

const WRITE_BATCH = 5000;

/**
 * Raw SQL rather than updateMany: Prisma's @updatedAt would bump ModelVersion."updatedAt", which is
 * on the public v1 payload and is remove-old-drafts' activity fence.
 */
export async function setGeneratorLoaded(ids: number[], loaded: boolean) {
  let updated = 0;
  for (const batch of chunk(ids, WRITE_BATCH))
    updated += await dbWrite.$executeRaw`
      UPDATE "ModelVersion" SET "generatorLoaded" = ${loaded} WHERE id = ANY(${batch}::int[])
    `;
  return updated;
}

/**
 * Every cache that serves residency, cleared after a `setGeneratorLoaded`: resourceDataCache to the
 * submit path (an hour, refusing a resource that has loaded) and the residency cache to the
 * Generation rows and submit's download estimate. Callers clear only after the search-index
 * enqueue — see the sync job.
 */
export async function bustGeneratorLoadedCaches(ids: number[]) {
  if (!ids.length) return;
  await Promise.all([resourceDataCache.bust(ids), bustResourceResidency(ids)]);
}
