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
