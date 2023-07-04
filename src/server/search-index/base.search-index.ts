import { clickhouse } from '~/server/clickhouse/client';
import { getJobDate } from '~/server/jobs/job';
import { dbWrite } from '~/server/db/client';
import { PrismaClient } from '@prisma/client';

const DEFAULT_UPDATE_INTERVAL = 60 * 1000;

export function createSearchIndexUpdateProcessor({
  indexName,
  onIndexUpdate,
  updateInterval = DEFAULT_UPDATE_INTERVAL,
}: {
  indexName: string;
  onIndexUpdate: SearchIndexProcessorContext;
  updateInterval?: number;
}) {
  return {
    indexName,
    async update() {
      if (!clickhouse) return;
      const [lastUpdatedAt, setLastUpdate] = await getJobDate(
        `searchIndex:${indexName.toLowerCase()}`
      );
      const ctx = { db: dbWrite, lastUpdatedAt };

      // Check if update is needed
      const shouldUpdate = lastUpdatedAt.getTime() + updateInterval < Date.now();
      if (!shouldUpdate) {
        console.log(
          'createSearchIndexUpdateProcessor :: update :: Job does not require updating yet.'
        );
        return;
      }

      // Run update
      await onIndexUpdate(ctx);
      await setLastUpdate();

      // Clear update queue
      await dbWrite.searchIndexUpdateQueue.deleteMany({
        where: { type: indexName, createdAt: { lt: new Date() } },
      });
    },
    queueUpdate: async (id: number) => {
      await dbWrite.$executeRaw`
        INSERT INTO "SearchIndexUpdateQueue" ("type", "id")
        VALUES (${indexName}, ${id})
        ON CONFLICT ("type", "id") DO UPDATE SET "createdAt" = NOW()
      `;
    },
  };
}
export type SearchIndexRunContext = {
  db: PrismaClient;
  lastUpdatedAt: Date;
};

type SearchIndexProcessorContext = (context: SearchIndexRunContext) => Promise<void>;
