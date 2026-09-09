// App shim for @civitai/telemetry. Re-exports the generic prom helpers + metric
// definitions, and registers the DB pool-depth gauges here — they compose the db
// pools + prom helpers, which is app-level glue, not infrastructure.
import client from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
  redisCommandsInflight,
  redisCommandDuration,
  packedCodecDuration,
  sysredisSentinelTopologyChangesCounter,
  sysredisSentinelClientErrorsCounter,
  redisSelfHealReconnectCounter,
  redisSelfHealDeadlineHitsWindow,
  redisRoutingRetryCounter,
} from '@civitai/telemetry/client';
// Type-only: the CONSUMER's view of the bridge object published below. A `import type` cannot pull
// any of @civitai/redis's runtime into this module's graph — it is erased at build.
import type { RedisMetricsBridge } from '@civitai/redis';
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
//
// 🔴 THE `satisfies` IS THE GUARD, AND IT IS THE ONLY THING THAT COVERS THE "@civitai/redis GREW A
// HANDLE" DIRECTION. Every consumer read over there is optional-chained
// (`getRedisMetrics()?.packedCodecDuration?.observe(...)`), so a handle the package reads and this
// object does not publish is a metric that is silently dead: no throw, no warning, and an
// eternally-empty series indistinguishable from "nothing opted in". No runtime test can see it —
// the package's own suite installs a fake bridge, and this app's bridge test compares this object
// only against its own hand-written ledger, so both sides move together whenever one person edits
// them. Comparing against the CONSUMER'S type is the only check with an independent side.
//
// `Record<keyof RedisMetricsBridge, unknown>` is deliberately not just `RedisMetricsBridge`: most
// handles are declared OPTIONAL over there (so an older app publishing fewer still typechecks), and
// a plain `satisfies RedisMetricsBridge` therefore accepts every one of them being missing — i.e.
// it would accept exactly the defect. `Record<…>` makes each key REQUIRED here, and intersecting
// the real type back in keeps the value SHAPES checked. Excess-property checking on the literal
// covers the other direction (publishing a handle nothing reads).
//
// So: add a field to `RedisMetricsBridge` in @civitai/redis without adding it here and this file
// stops compiling. That is the intended failure — wire the handle, do not widen the type below.
const redisMetricsBridge = {
  redisCommandsInflight,
  redisCommandDuration,
  packedCodecDuration,
  sysredisSentinelTopologyChangesCounter,
  sysredisSentinelClientErrorsCounter,
  redisSelfHealReconnectCounter,
  redisSelfHealDeadlineHitsWindow,
  redisRoutingRetryCounter,
} satisfies RedisMetricsBridge & Record<keyof RedisMetricsBridge, unknown>;

(globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics =
  redisMetricsBridge;

// pgPoolAcquireHistogram is registered in @civitai/db's db-helpers, not here, to avoid
// a module-init cycle (this module imports pgDb → db-helpers, which would import the
// histogram back), which webpack's CJS chunking can break with a TDZ error at runtime.

// `heavyBulkheadGaugeInitialized` was declared here and is gone: a globalThis flag guarding a
// per-graph registry is the bug this file documents at length below, not a pattern to reach for.
// Deduplication for anything on the shared registry comes from registerInstrumentationMetric,
// which checks the same registry it writes to, so the flag's one legitimate job is covered.
//
// `pgGaugeInitialized` SURVIVES, deliberately, and is the exception that proves the rule — see the
// long note above the pg block near the bottom of this file. Those gauges cannot move to the
// shared registry until the pools they read are themselves process-wide.
declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var pgGaugeInitialized: boolean;
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

registerInstrumentationMetric(
  PROM_PREFIX + 'image_ingestion_backlog',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'image_ingestion_backlog',
      help: 'Images in a non-terminal working ingestion state (Pending/Error/Rescan/PendingManualAssignment)',
      labelNames: ['status'],
      registers: [instrumentationRegistry],
      collect() {
        maybeRefreshIngestionBacklog();
        this.reset();
        for (const row of ingestionBacklogCache) this.set({ status: row.status }, row.backlog);
      },
    })
);
registerInstrumentationMetric(
  PROM_PREFIX + 'image_ingestion_oldest_age_seconds',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'image_ingestion_oldest_age_seconds',
      help: 'Age in seconds of the oldest image (now - min(createdAt)) per non-terminal ingestion state',
      labelNames: ['status'],
      registers: [instrumentationRegistry],
      collect() {
        maybeRefreshIngestionBacklog();
        this.reset();
        for (const row of ingestionBacklogCache)
          this.set({ status: row.status }, row.oldestAgeSeconds);
      },
    })
);

// 🔴 WHY THE BULKHEAD GAUGES USE registerInstrumentationMetric, AND WHY A globalThis
// "initialized" FLAG IS THE WRONG TOOL FOR THEM.
//
// Not every gauge below: the nine pg pool gauges further down deliberately KEEP
// `if (!global.pgGaugeInitialized)` and stay off the shared registry. The note at that block
// explains why moving them was tried, measured, and reverted.
//
// This module is evaluated in BOTH webpack graphs: the instrumentation graph reaches it at pod
// start (instrumentation.node.ts -> ~/server/eventloop-longtask -> here), and the pages/API graph
// reaches it later, on the first request that loads a route importing it — including /api/metrics
// itself. prom-client is not in serverExternalPackages, so each graph gets its own module instance
// and therefore its own default `client.register`. /api/metrics scrapes the PAGES graph's default
// registry plus the globalThis-pinned `instrumentationRegistry`; the instrumentation graph's
// default registry is scraped by nobody.
//
// The bulkhead block below used to be wrapped in `if (!global.heavyBulkheadGaugeInitialized)`,
// exactly as the pg block still is. That pairs a PROCESS-scoped flag with a GRAPH-scoped
// registry, and the mismatch is fatal in one direction only: the instrumentation graph gets here
// first, registers every gauge into its own unscraped registry, and sets the flag — so when the
// pages graph evaluates this module it takes the early-out and registers NOTHING into the registry
// that is actually served. The metrics look registered in code, in a deployed image, on a hot
// route, and emit no series ever.
//
// Measured on production before the fix: civitai_app_heavy_bulkhead_{active,rejects} and all nine
// node_postgres_* gauges = 0 series, while `civitai_app_image_ingestion_backlog` (same file, but
// registered via registerInstrumentationMetric) = 640 series and `images_search_*` (default
// registry, pages graph, NO globalThis flag) = 181 series. Those three groups isolate the flag as
// the variable: same file and same registry choice differ only by the guard.
//
// registerInstrumentationMetric is the correct idempotence primitive because it dedupes against
// the SHARED registry it registers into, so the two scopes agree: whichever graph arrives first
// creates the gauge, the second finds it and reuses it, and either way it is scraped.
//
// The gauges are collect()-based, so it also matters WHICH graph's closure wins — the state they
// read must be shared too. request-bulkhead.ts pins its slot/reject maps on globalThis for exactly
// this reason; fixing this file alone would have left both gauges registered, scraped, and still
// emitting nothing.
registerInstrumentationMetric(
  PROM_PREFIX + 'heavy_bulkhead_active',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'heavy_bulkhead_active',
      help: 'In-flight heavy-route bulkhead slots per key (per pod)',
      labelNames: ['key'],
      registers: [instrumentationRegistry],
      collect() {
        for (const { key, active } of bulkheadSnapshot()) this.set({ key }, active);
      },
    })
);
// Deliberately NOT this.reset()-ed: the value is cumulative per key for the life of the pod, which
// is what makes rate() meaningful. A reset would still be atomic within collect(), but stating the
// intent here keeps a later "tidy-up" from turning a counter-shaped gauge into a sawtooth.
registerInstrumentationMetric(
  PROM_PREFIX + 'heavy_bulkhead_rejects',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'heavy_bulkhead_rejects',
      help: 'Cumulative heavy-route bulkhead fast-fail rejects per key (per pod); monotonic, use rate()',
      labelNames: ['key'],
      registers: [instrumentationRegistry],
      collect() {
        for (const { key, rejects } of bulkheadSnapshot()) this.set({ key }, rejects);
      },
    })
);

// 🔴 THE PG POOL GAUGES ARE DELIBERATELY LEFT ON THE UNSCRAPED REGISTRY. DO NOT "FIX" THEM
// THE WAY THE BULKHEAD GAUGES WERE FIXED — IT WAS TRIED HERE AND IT MAKES THEM WORSE.
//
// They carry the same registration defect (a globalThis flag guarding a per-graph registry), so
// moving them to `instrumentationRegistry` does make them appear in the scrape. But a
// collect()-based metric needs BOTH halves shared: the registry it registers into AND the state
// its closure reads. The bulkhead has both — `request-bulkhead.ts` pins its maps on globalThis.
// These do not: `src/server/db/pgDb.ts` globalThis-pins the pools ONLY in the `!isProd` branch, so
// in production every emitted copy of that module builds its OWN pg pools. The graph that wins
// registration is the instrumentation graph, whose pools serve nothing but the ingestion-backlog
// query in this file.
//
// Measured on a preview running exactly that change: `node_postgres_read_total_count` read 1 while
// idle and still 1 under 30 concurrent `/api/v1/images` requests, with every write-pool gauge at 0
// throughout. Frozen, plausible-looking, and wrong — which is strictly worse than the honest
// absence they have today. It is the same false-all-clear class as an `or vector(0)` on a panel
// whose metric does not exist: an absent metric prompts a question, a confident 0 ends one.
//
// Making them real means pinning the pools in `pgDb.ts` for prod too. That changes production DB
// connection topology (today: one pool set per emitted graph), so it is its own change with its
// own blast radius, not a rider on a metrics fix.
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

/**
 * Buzz still parked in escrow because a payout leg gave up.
 *
 * A gauge rather than an error log, because this is "something is still broken"
 * rather than "something just broke". The one-shot error at the moment a leg
 * exhausts carries the event; a windowed error log cannot carry the state, since
 * an exhausted leg stops being touched and so drops out of any window over its
 * last attempt — reporting for a while and then going permanently silent with
 * the money still parked.
 */
export const placementExhaustedLegsGauge = registerInstrumentationMetric(
  PROM_PREFIX + 'placement_exhausted_legs',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'placement_exhausted_legs',
      help: 'Placement payout legs that have exhausted their retries and still hold Buzz in escrow',
      registers: [instrumentationRegistry],
    })
);

/**
 * Settled placements with no payout plan and no escrow behind them.
 *
 * These are terminal rather than recoverable, so `sweepUnplannedSettlements`
 * excludes them from its batch — otherwise they match its query forever and,
 * past the batch limit, crowd out settlements that can still be resolved. A
 * gauge is what keeps that exclusion from meaning silence.
 *
 * The population is mostly benign: a placement whose escrow could not be taken
 * is expired immediately and lands here. It also contains the one case nothing
 * can recover — a hold charged whose receipt was lost to a crash — which is
 * indistinguishable from a hold that never charged, and is the reason this is
 * reported at all rather than filtered away.
 */
export const placementUnfundedSettlementsGauge = registerInstrumentationMetric(
  PROM_PREFIX + 'placement_unfunded_settlements',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'placement_unfunded_settlements',
      help: 'Settled placements with no payout plan and no receipted escrow behind them',
      registers: [instrumentationRegistry],
    })
);

/**
 * Images that the restricted-base-model reconcile had to flag on its last run.
 *
 * A steady zero is the healthy state, so this gauge cannot be read on its own:
 * a gauge that was never set scrapes as 0, and so does a job that has not run
 * since October. Alert on it together with
 * `restricted_image_reconcile_last_success_timestamp` below, which is the only
 * thing that distinguishes "no drift" from "no job".
 */
export const restrictedImageDriftGauge = registerInstrumentationMetric(
  PROM_PREFIX + 'restricted_image_drift',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'restricted_image_drift',
      help: 'Images the restricted-base-model reconcile flagged on its last run',
      registers: [instrumentationRegistry],
    })
);

export const restrictedImageReconcileLastSuccessGauge = registerInstrumentationMetric(
  PROM_PREFIX + 'restricted_image_reconcile_last_success_timestamp',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'restricted_image_reconcile_last_success_timestamp',
      help: 'Unix seconds at which the restricted-base-model reconcile last completed',
      registers: [instrumentationRegistry],
    })
);

/**
 * Base models the code licence data and the `RestrictedBaseModels` table disagree about.
 *
 * `missing_in_db` is the failure that produced the 2025-10 exposure: a licence
 * restricting NSFW was added in code, nobody added the DB row, and every Postgres
 * read path went on treating that base model as unrestricted while search hid it.
 * Nothing reconciles the two by design — restricting a base model hides live
 * creator content, so it stays a deliberate act rather than a deploy artifact.
 */
export const restrictedBaseModelDivergenceGauge = registerInstrumentationMetric(
  PROM_PREFIX + 'restricted_base_model_divergence',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'restricted_base_model_divergence',
      help: 'Base models present in one restricted list and not the other',
      labelNames: ['direction'],
      registers: [instrumentationRegistry],
    })
);

/**
 * Flagged images that no longer qualify — the recovery queue, reported and never acted on.
 *
 * Un-hiding restores content to public feeds, which is a moderation decision rather
 * than a reconciliation, so the job never clears the flag. This is the number that
 * says how much is sitting hidden without a current reason, and the query behind it
 * is also the answer to "which images do we restore" if a model owner ever flips a
 * base model to a restricted value and back. Read it with the heartbeat below: an
 * unset gauge scrapes as 0, which here reads as the reassuring answer.
 */
export const restrictedImageOverhiddenGauge = registerInstrumentationMetric(
  PROM_PREFIX + 'restricted_image_overhidden',
  () =>
    new client.Gauge({
      name: PROM_PREFIX + 'restricted_image_overhidden',
      help: 'Images flagged modelRestricted that no longer match any restricted base model',
      registers: [instrumentationRegistry],
    })
);
