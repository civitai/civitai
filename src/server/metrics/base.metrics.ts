import type { ClickHouseClient } from '@clickhouse/client';
import type { PrismaClient } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import type { JobContext } from '~/server/jobs/job';
import { getJobDate } from '~/server/jobs/job';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { addToQueue, checkoutQueue } from '~/server/redis/queues';

const DEFAULT_UPDATE_INTERVAL = 60 * 1000;
const DEFAULT_RANK_REFRESH_INTERVAL = 60 * 60 * 1000;

export function createMetricProcessor({
  disabled,
  name,
  update,
  updateInterval = DEFAULT_UPDATE_INTERVAL,
  clearDay,
  rank,
  lockTime,
}: {
  disabled?: boolean;
  name: string;
  update: MetricContextProcessor;
  updateInterval?: number;
  clearDay?: MetricContextProcessor;
  rank?: MetricRankOptions;
  lockTime?: number;
}) {
  return {
    name,
    async update(jobContext: JobContext) {
      if (!clickhouse || disabled) return;
      const [lastUpdate, setLastUpdate] = await getJobDate(`metric:${name.toLowerCase()}`);
      const ctx: MetricProcessorRunContext = {
        db: dbWrite,
        ch: clickhouse,
        pg: pgDbWrite,
        lastUpdate,
        jobContext,
        queue: [],
        affected: new Set(),
        addAffected: (id) => {
          if (Array.isArray(id)) id.forEach((x) => ctx.affected.add(x));
          else ctx.affected.add(id);
        },
      };

      // Clear if first run of the day
      const isFirstOfDay = lastUpdate.getDate() !== new Date().getDate();
      if (isFirstOfDay) await clearDay?.(ctx);

      // Check if update is needed
      const shouldUpdate = lastUpdate.getTime() + updateInterval < Date.now();
      const metricUpdateAllowed =
        ((await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, `metric:${name.toLowerCase()}`)) ??
          'true') === 'true';
      if (!shouldUpdate || !metricUpdateAllowed) return;

      // Run update
      const queue = await checkoutQueue('metric-update:' + name);
      ctx.queue = queue.content;
      ctx.lastUpdate = dayjs(lastUpdate).subtract(2, 'minute').toDate(); // Expand window to allow clickhouse tracker to catch up
      await update(ctx);
      await setLastUpdate();

      // Clear update queue
      await queue.commit();
    },
    async refreshRank(jobContext: JobContext) {
      if (!rank || !clickhouse || disabled) return;

      // Check if rank refresh is needed
      const [lastUpdate, setLastUpdate] = await getJobDate(`rank:${name.toLowerCase()}`);
      const refreshInterval = rank.refreshInterval ?? DEFAULT_RANK_REFRESH_INTERVAL;
      const shouldUpdateRank = lastUpdate.getTime() + refreshInterval < Date.now();
      const rankUpdateAllowed =
        ((await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, `rank:${name.toLowerCase()}`)) ??
          'true') === 'true';
      if (!shouldUpdateRank || !rankUpdateAllowed) return;

      // Run rank refresh
      const ctx: RankProcessorRunContext = {
        db: dbWrite,
        pg: pgDbWrite,
        ch: clickhouse,
        lastUpdate,
        jobContext,
      };
      if ('refresh' in rank) await rank.refresh(ctx);
      else await recreateRankTable(rank.table, rank.primaryKey, rank.indexes);

      await setLastUpdate();
    },
    queueUpdate: async (ids: number | number[]) => {
      if (disabled) return;
      if (!Array.isArray(ids)) ids = [ids];
      await addToQueue('metric-update:' + name.toLowerCase(), ids);
    },
    lockTime,
  };
}

async function recreateRankTable(rankTable: string, primaryKey: string, indexes: string[] = []) {
  await dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "${rankTable}_New";`);
  await dbWrite.$executeRawUnsafe(
    `CREATE TABLE "${rankTable}_New" AS
    SELECT *
    FROM "${rankTable}_Live";`
  );
  await dbWrite.$executeRawUnsafe(
    `ALTER TABLE "${rankTable}_New"
      ADD CONSTRAINT "pk_${rankTable}_New" PRIMARY KEY ("${primaryKey}")`
  );
  await dbWrite.$executeRawUnsafe(
    `CREATE INDEX "${rankTable}_New_idx" ON "${rankTable}_New" ("${primaryKey}")`
  );
  for (const index of indexes) {
    await dbWrite.$executeRawUnsafe(
      `CREATE INDEX "${rankTable}_New_${index}_idx" ON "${rankTable}_New" ("${index}")`
    );
  }

  await dbWrite.$transaction([
    dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "${rankTable}";`),
    dbWrite.$executeRawUnsafe(`ALTER TABLE "${rankTable}_New"
      RENAME TO "${rankTable}";`),
    dbWrite.$executeRawUnsafe(
      `ALTER TABLE "${rankTable}"
        RENAME CONSTRAINT "pk_${rankTable}_New" TO "pk_${rankTable}";`
    ),
    dbWrite.$executeRawUnsafe(`ALTER INDEX "${rankTable}_New_idx" RENAME TO "${rankTable}_idx";`),
    ...indexes.map((index) =>
      dbWrite.$executeRawUnsafe(
        `ALTER INDEX "${rankTable}_New_${index}_idx" RENAME TO "${rankTable}_${index}_idx";`
      )
    ),
  ]);
}

export type RankProcessorRunContext = {
  db: PrismaClient;
  pg: AugmentedPool;
  ch: ClickHouseClient;
  lastUpdate: Date;
  jobContext: JobContext;
};

export type MetricProcessorRunContext = {
  db: PrismaClient;
  pg: AugmentedPool;
  ch: CustomClickHouseClient;
  lastUpdate: Date;
  jobContext: JobContext;
  queue: number[];
  addAffected: (id: number | number[]) => void;
  affected: Set<number>;
};

type MetricRankOptions =
  | {
      table: string;
      primaryKey: string;
      indexes?: string[];
      refreshInterval?: number;
    }
  | {
      refresh: RankContextProcessor;
      refreshInterval?: number;
    };
type MetricContextProcessor = (context: MetricProcessorRunContext) => Promise<void>;
type RankContextProcessor = (context: RankProcessorRunContext) => Promise<void>;
