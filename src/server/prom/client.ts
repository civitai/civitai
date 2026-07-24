// App shim for @civitai/telemetry. Re-exports the generic prom helpers + metric
// definitions, and registers the DB pool-depth gauges here — they compose the db
// pools + prom helpers, which is app-level glue, not infrastructure.
import client from 'prom-client';
import {
  PROM_PREFIX,
  redisCommandsInflight,
  redisCommandDuration,
  sysredisSentinelTopologyChangesCounter,
  sysredisSentinelClientErrorsCounter,
  redisSelfHealReconnectCounter,
  redisSelfHealDeadlineHitsWindow,
  redisRoutingRetryCounter,
} from '@civitai/telemetry/client';
import { datapacketDbRead } from '~/server/db/datapacketDb';
import { pgDbRead, pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
// request-bulkhead is a pure leaf module (no imports), so this edge cannot form a cycle.
import { bulkheadSnapshot } from '~/server/utils/request-bulkhead';

export * from '@civitai/telemetry/client';

// Bridge to @civitai/redis via globalThis: the redis client lives in a package that must NOT
// statically import prom-client (it's reachable from the client bundle), so it reads these metric
// handles off globalThis at command/connect time (getRedisMetrics()/attachSysSentinelListeners).
// Publishing here — where prom-client is already loaded — captures them directly. No eager
// reader exists; consumed only from @civitai/redis client function bodies (self-heal watchdog +
// routing-retry path).
(globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics = {
  redisCommandsInflight,
  redisCommandDuration,
  sysredisSentinelTopologyChangesCounter,
  sysredisSentinelClientErrorsCounter,
  redisSelfHealReconnectCounter,
  redisSelfHealDeadlineHitsWindow,
  redisRoutingRetryCounter,
};

// pgPoolAcquireHistogram is registered in @civitai/db's db-helpers, not here, to avoid
// a module-init cycle (this module imports pgDb → db-helpers, which would import the
// histogram back), which webpack's CJS chunking can break with a TDZ error at runtime.

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var pgGaugeInitialized: boolean;
  // eslint-disable-next-line no-var
  var heavyBulkheadGaugeInitialized: boolean;
  // eslint-disable-next-line no-var
  var imageIngestionGaugeInitialized: boolean;
}

// Image-ingestion working-state backlog + oldest-age gauges. These are DB-derived,
// so they must NOT hit Postgres on every /metrics scrape (~15s). The query is served
// from an in-process cache with a short TTL and refreshed lazily off the scrape path
// (fire-and-forget) — a scrape only ever kicks a background refresh, never blocks on
// it, and reads the last-known values.
//
// DB SAFETY: the Image table is enormous and Scanned dominates it, so an unfiltered
// GROUP BY over `ingestion` would seq-scan the whole table. Instead each working state
// is counted independently and UNION ALL'd, which lets Postgres serve every branch
// index-only from the existing per-state indexes (~1s). A defensive statement_timeout
// caps the rare replica cold-cache spike; on timeout we keep the last-known values.
const INGESTION_GAUGE_TTL_MS = 45_000;
const INGESTION_GAUGE_STATEMENT_TIMEOUT_MS = 10_000;

const INGESTION_BACKLOG_SQL = `
  SELECT 'Pending' AS status, count(*) AS backlog, min("createdAt") AS oldest
    FROM "Image" WHERE ingestion='Pending'
  UNION ALL
  SELECT 'Error', count(*), min("createdAt")
    FROM "Image" WHERE ingestion='Error'
  UNION ALL
  SELECT 'Rescan', count(*), min("createdAt")
    FROM "Image" WHERE ingestion='Rescan'
  UNION ALL
  SELECT 'PendingManualAssignment', count(*), min("createdAt")
    FROM "Image" WHERE ingestion='PendingManualAssignment'`;

type IngestionBacklogRow = { status: string; backlog: number; oldestAgeSeconds: number };
let ingestionBacklogCache: IngestionBacklogRow[] = [];
let ingestionBacklogFetchedAt = 0;
let ingestionBacklogInflight: Promise<void> | null = null;

async function queryIngestionBacklog() {
  // SET LOCAL binds the statement_timeout to this backend for the txn only, so the
  // pool's default policy is untouched. Checkout is required for it to apply.
  const dbClient = await pgDbRead.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(`SET LOCAL statement_timeout = ${INGESTION_GAUGE_STATEMENT_TIMEOUT_MS}`);
    const res = await dbClient.query<{ status: string; backlog: string; oldest: Date | null }>(
      INGESTION_BACKLOG_SQL
    );
    await dbClient.query('COMMIT');
    return res.rows;
  } catch (e) {
    await dbClient.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    dbClient.release();
  }
}

function refreshIngestionBacklog() {
  if (ingestionBacklogInflight) return ingestionBacklogInflight;
  ingestionBacklogInflight = queryIngestionBacklog()
    .then((rows) => {
      ingestionBacklogCache = rows.map((r) => ({
        status: r.status,
        backlog: Number(r.backlog),
        oldestAgeSeconds: r.oldest != null ? (Date.now() - new Date(r.oldest).getTime()) / 1000 : 0,
      }));
      ingestionBacklogFetchedAt = Date.now();
    })
    .catch(() => {
      // Swallow (incl. statement_timeout): keep the last-known values so a transient
      // DB hiccup can't break the /metrics scrape. A stale gauge beats a 500.
    })
    .finally(() => {
      ingestionBacklogInflight = null;
    });
  return ingestionBacklogInflight;
}

function maybeRefreshIngestionBacklog() {
  if (Date.now() - ingestionBacklogFetchedAt > INGESTION_GAUGE_TTL_MS)
    void refreshIngestionBacklog();
}

if (!global.imageIngestionGaugeInitialized) {
  new client.Gauge({
    name: PROM_PREFIX + 'image_ingestion_backlog',
    help: 'Images in a non-terminal working ingestion state (Pending/Error/Rescan/PendingManualAssignment)',
    labelNames: ['status'],
    collect() {
      maybeRefreshIngestionBacklog();
      this.reset();
      for (const row of ingestionBacklogCache) this.set({ status: row.status }, row.backlog);
    },
  });
  new client.Gauge({
    name: PROM_PREFIX + 'image_ingestion_oldest_age_seconds',
    help: 'Age in seconds of the oldest image (now - min(createdAt)) per non-terminal ingestion state',
    labelNames: ['status'],
    collect() {
      maybeRefreshIngestionBacklog();
      this.reset();
      for (const row of ingestionBacklogCache)
        this.set({ status: row.status }, row.oldestAgeSeconds);
    },
  });
  global.imageIngestionGaugeInitialized = true;
}

// Heavy-route bulkhead observability (per pod). collect()-based so it reflects the
// live in-process state on each scrape with no per-request work. This is the signal
// for tuning HEAVY_REQUEST_CONCURRENCY: rejects climbing means the pod is shedding.
if (!global.heavyBulkheadGaugeInitialized) {
  new client.Gauge({
    name: PROM_PREFIX + 'heavy_bulkhead_active',
    help: 'In-flight heavy-route bulkhead slots per key (per pod)',
    labelNames: ['key'],
    collect() {
      for (const { key, active } of bulkheadSnapshot()) this.set({ key }, active);
    },
  });
  new client.Gauge({
    name: PROM_PREFIX + 'heavy_bulkhead_rejects',
    help: 'Cumulative heavy-route bulkhead fast-fail rejects per key (per pod); monotonic, use rate()',
    labelNames: ['key'],
    collect() {
      for (const { key, rejects } of bulkheadSnapshot()) this.set({ key }, rejects);
    },
  });
  global.heavyBulkheadGaugeInitialized = true;
}

if (!global.pgGaugeInitialized) {
  new client.Gauge({
    name: 'node_postgres_read_total_count',
    help: 'node postgres read total count',
    collect() {
      this.set(pgDbRead.totalCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_read_idle_count',
    help: 'node postgres read idle count',
    collect() {
      this.set(pgDbRead.idleCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_read_waiting_count',
    help: 'node postgres read waiting count',
    collect() {
      this.set(pgDbRead.waitingCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_write_total_count',
    help: 'node postgres write total count',
    collect() {
      this.set(pgDbWrite.totalCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_write_idle_count',
    help: 'node postgres write idle count',
    collect() {
      this.set(pgDbWrite.idleCount);
    },
  });
  new client.Gauge({
    name: 'node_postgres_write_waiting_count',
    help: 'node postgres write waiting count',
    collect() {
      this.set(pgDbWrite.waitingCount);
    },
  });

  // Labeled pool metrics for all pools
  new client.Gauge({
    name: 'node_postgres_pool_total_count',
    help: 'Total connections in pg pool',
    labelNames: ['pool'],
    collect() {
      this.set({ pool: 'read' }, pgDbRead?.totalCount ?? 0);
      this.set({ pool: 'write' }, pgDbWrite?.totalCount ?? 0);
      this.set({ pool: 'read_long' }, pgDbReadLong?.totalCount ?? 0);
      this.set({ pool: 'datapacket_read' }, datapacketDbRead?.totalCount ?? 0);
    },
  });
  new client.Gauge({
    name: 'node_postgres_pool_idle_count',
    help: 'Idle connections in pg pool',
    labelNames: ['pool'],
    collect() {
      this.set({ pool: 'read' }, pgDbRead?.idleCount ?? 0);
      this.set({ pool: 'write' }, pgDbWrite?.idleCount ?? 0);
      this.set({ pool: 'read_long' }, pgDbReadLong?.idleCount ?? 0);
      this.set({ pool: 'datapacket_read' }, datapacketDbRead?.idleCount ?? 0);
    },
  });
  new client.Gauge({
    name: 'node_postgres_pool_waiting_count',
    help: 'Waiting connections in pg pool',
    labelNames: ['pool'],
    collect() {
      this.set({ pool: 'read' }, pgDbRead?.waitingCount ?? 0);
      this.set({ pool: 'write' }, pgDbWrite?.waitingCount ?? 0);
      this.set({ pool: 'read_long' }, pgDbReadLong?.waitingCount ?? 0);
      this.set({ pool: 'datapacket_read' }, datapacketDbRead?.waitingCount ?? 0);
    },
  });

  global.pgGaugeInitialized = true;
}
