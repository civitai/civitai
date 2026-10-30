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
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
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
      // sysRedis.hGet is typed string but the HA/Sentinel client returns a
      // Buffer for BLOB_STRING replies. `Buffer === 'true'` is always false,
      // which silently flips this flag to disabled in sentinel mode. Coerce
      // to a utf8 string before comparing. See PR #2697 for the canonical
      // regression case (queues.ts getBucketNames).
      let metricRaw: string | Buffer | null = null;
      try {
        metricRaw = await withSysReadDeadline(
          sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, `metric:${name.toLowerCase()}`)
        );
      } catch (err) {
        // sysRedis DOWN (throw) or SLOW (deadline) — the metric kill-switch fails
        // OPEN to its absent default ('true' = allowed) below. Metric/rank updates
        // are DB/ClickHouse-driven and non-destructive, and the queue commit is
        // already blip-hardened (#2922), so a sysRedis stall must not stop them.
        // Emit the fail-open so a blip that silently bypasses a deliberately-set
        // 'false' kill-switch is visible (Loki `sysredis-fail-open`), matching the
        // queues.ts safeSysRead pattern.
        logSysRedisFailOpen('read-degraded', 'base.metrics metric-flag', err, { metric: name });
        metricRaw = null;
      }
      const metricFlag = Buffer.isBuffer(metricRaw) ? metricRaw.toString('utf8') : metricRaw;
      const metricUpdateAllowed = (metricFlag ?? 'true') === 'true';
      if (!shouldUpdate || !metricUpdateAllowed) return;

      // Run update
      // NOTE: must match the casing used in queueUpdate (name.toLowerCase()) below —
      // otherwise reader/writer keys diverge (e.g. 'metric-update:Post' vs
      // 'metric-update:post') and every explicitly-queued update is silently dropped.
      const queue = await checkoutQueue('metric-update:' + name.toLowerCase());
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
      // Buffer-coerce mirror of the metric flag above. Same root cause —
      // sentinel-mode sysRedis returns Buffer, which silently fails the
      // === 'true' check. See PR #2697.
      let rankRaw: string | Buffer | null = null;
      try {
        rankRaw = await withSysReadDeadline(
          sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, `rank:${name.toLowerCase()}`)
        );
      } catch (err) {
        // sysRedis DOWN/SLOW — the rank kill-switch fails OPEN to its absent
        // default ('true' = allowed) below, same rationale as the metric flag.
        logSysRedisFailOpen('read-degraded', 'base.metrics rank-flag', err, { metric: name });
        rankRaw = null;
      }
      const rankFlag = Buffer.isBuffer(rankRaw) ? rankRaw.toString('utf8') : rankRaw;
      const rankUpdateAllowed = (rankFlag ?? 'true') === 'true';
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
      else await syncRankTable(rank.table, rank.primaryKey);

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

const RANK_SYNC_TIMEOUT = 5 * 60 * 1000;

// In place, never drop + recreate: a recreated table is owned by the job's role and loses its grants.
async function syncRankTable(rankTable: string, primaryKey: string) {
  const stage = `${rankTable}_Stage`;
  const pk = `"${primaryKey}"`;
  try {
    await dbWrite.$transaction(
      async (tx) => {
        // The table's columns, not the view's: a column the view adds is ignored.
        const columns = (
          await tx.$queryRawUnsafe<{ name: string }[]>(
            `SELECT attname AS name FROM pg_attribute
            WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
            ORDER BY attnum`,
            `"${rankTable}"`
          )
        ).map((c) => `"${c.name}"`);
        const cols = columns.join(', ');
        const values = columns.filter((c) => c !== pk);

        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE "${stage}" ON COMMIT DROP AS SELECT ${cols} FROM "${rankTable}_Live"`
        );
        await tx.$executeRawUnsafe(`ALTER TABLE "${stage}" ADD PRIMARY KEY (${pk})`);
        await tx.$executeRawUnsafe(`ANALYZE "${stage}"`);
        await tx.$executeRawUnsafe(
          `DELETE FROM "${rankTable}" r
          WHERE NOT EXISTS (SELECT 1 FROM "${stage}" s WHERE s.${pk} = r.${pk})`
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "${rankTable}" (${cols})
          SELECT ${cols} FROM "${stage}"
          ON CONFLICT (${pk}) DO UPDATE SET ${values.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
          WHERE (${values.map((c) => `"${rankTable}".${c}`).join(', ')})
            IS DISTINCT FROM (${values.map((c) => `EXCLUDED.${c}`).join(', ')})`
        );
      },
      { timeout: RANK_SYNC_TIMEOUT }
    );
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'metric-rank-sync-failed',
      message: `Rank table ${rankTable} failed to sync; it keeps its previous rows`,
      details: { table: rankTable, error: (error as Error)?.message },
    }).catch();
    throw error;
  }
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
      refreshInterval?: number;
    }
  | {
      refresh: RankContextProcessor;
      refreshInterval?: number;
    };
type MetricContextProcessor = (context: MetricProcessorRunContext) => Promise<void>;
type RankContextProcessor = (context: RankProcessorRunContext) => Promise<void>;
