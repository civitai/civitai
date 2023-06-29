import { ClickHouseClient } from '@clickhouse/client';
import { PrismaClient } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { getJobDate } from '~/server/jobs/job';

const DEFAULT_UPDATE_INTERVAL = 60 * 1000;
const DEFAULT_RANK_REFRESH_INTERVAL = 60 * 60 * 1000;

export function createMetricProcessor({
  name,
  update,
  updateInterval = DEFAULT_UPDATE_INTERVAL,
  clearDay,
  rank,
}: {
  name: string;
  update: MetricContextProcessor;
  updateInterval?: number;
  clearDay?: MetricContextProcessor;
  rank?: MetricRankOptions;
}) {
  return {
    name,
    async update() {
      if (!clickhouse) return;
      const [lastUpdate, setLastUpdate] = await getJobDate(`metric:${name.toLowerCase()}`);
      const ctx = { db: dbWrite, ch: clickhouse, lastUpdate };

      // Clear if first run of the day
      const isFirstOfDay = lastUpdate.getDate() !== new Date().getDate();
      if (isFirstOfDay) await clearDay?.(ctx);

      // Check if update is needed
      const shouldUpdate = lastUpdate.getTime() + updateInterval < Date.now();
      if (!shouldUpdate) return;

      // Run update
      await update(ctx);
      await setLastUpdate();

      // Clear update queue
      await dbWrite.metricUpdateQueue.deleteMany({
        where: { type: name, createdAt: { lt: new Date() } },
      });
    },
    async refreshRank() {
      if (!rank || !clickhouse) return;

      // Check if rank refresh is needed
      const [lastUpdate, setLastUpdate] = await getJobDate(`rank:${name.toLowerCase()}`);
      const refreshInterval = rank.refreshInterval ?? DEFAULT_RANK_REFRESH_INTERVAL;
      const shouldUpdateRank = lastUpdate.getTime() + refreshInterval < Date.now();
      if (!shouldUpdateRank) return;

      // Run rank refresh
      const ctx = { db: dbWrite, ch: clickhouse, lastUpdate };
      if ('refresh' in rank) await rank.refresh(ctx);
      else await recreateRankTable(rank.table, rank.primaryKey, rank.indexes);

      await setLastUpdate();
    },
    queueUpdate: async (id: number, db?: PrismaClient) => {
      await (db ?? dbWrite).$executeRaw`
        INSERT INTO "MetricUpdateQueue" ("type", "id")
        VALUES (${name}, ${id})
        ON CONFLICT ("type", "id") DO UPDATE SET "createdAt" = NOW()
      `;
    },
  };
}

async function recreateRankTable(rankTable: string, primaryKey: string, indexes: string[] = []) {
  await dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "${rankTable}_New";`);
  await dbWrite.$executeRawUnsafe(
    `CREATE TABLE "${rankTable}_New" AS SELECT * FROM "${rankTable}_Live";`
  );
  await dbWrite.$executeRawUnsafe(
    `ALTER TABLE "${rankTable}_New" ADD CONSTRAINT "pk_${rankTable}_New" PRIMARY KEY ("${primaryKey}")`
  );
  await dbWrite.$executeRawUnsafe(
    `CREATE INDEX "${rankTable}_New_idx" ON "${rankTable}_New"("${primaryKey}")`
  );
  for (const index of indexes) {
    await dbWrite.$executeRawUnsafe(
      `CREATE INDEX "${rankTable}_New_${index}_idx" ON "${rankTable}_New"("${index}")`
    );
  }

  await dbWrite.$transaction([
    dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "${rankTable}";`),
    dbWrite.$executeRawUnsafe(`ALTER TABLE "${rankTable}_New" RENAME TO "${rankTable}";`),
    dbWrite.$executeRawUnsafe(
      `ALTER TABLE "${rankTable}" RENAME CONSTRAINT "pk_${rankTable}_New" TO "pk_${rankTable}";`
    ),
    dbWrite.$executeRawUnsafe(`ALTER INDEX "${rankTable}_New_idx" RENAME TO "${rankTable}_idx";`),
    ...indexes.map((index) =>
      dbWrite.$executeRawUnsafe(
        `ALTER INDEX "${rankTable}_New_${index}_idx" RENAME TO "${rankTable}_${index}_idx";`
      )
    ),
  ]);
}

export type MetricProcessorRunContext = {
  db: PrismaClient;
  ch: ClickHouseClient;
  lastUpdate: Date;
};

type MetricRankOptions =
  | {
      table: string;
      primaryKey: string;
      indexes?: string[];
      refreshInterval?: number;
    }
  | {
      refresh: MetricContextProcessor;
      refreshInterval?: number;
    };
type MetricContextProcessor = (context: MetricProcessorRunContext) => Promise<void>;
