import { Prisma } from '@prisma/client';
import type { QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { performance } from 'node:perf_hooks';
import client from 'prom-client';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

// Histogram for pg Pool acquire latency. Defined here (not in prom/client.ts)
// to avoid a module-init cycle: prom/client.ts imports pgDb/notifDb/datapacketDb,
// which import db-helpers. If db-helpers also imported a const from prom/client.ts,
// webpack's CJS-style chunking can leave that binding in a Temporal Dead Zone
// during module init — observed as "Cannot access 'S' before initialization" +
// V8 heap OOM on PR-preview 2322 (commit 664aa4c2e).
//
// prom-client itself has no cycle back into our code, so importing it directly
// is safe. Unprefixed name matches the existing node_postgres_pool_* gauges in
// prom/client.ts so dashboards correlate on the same metric family.
const PG_POOL_ACQUIRE_HISTOGRAM_NAME = 'node_postgres_pool_acquire_duration_seconds';
const pgPoolAcquireHistogram = (() => {
  try {
    return new client.Histogram({
      name: PG_POOL_ACQUIRE_HISTOGRAM_NAME,
      help: 'Time spent awaiting a connection from a pg.Pool, by pool instance and result',
      labelNames: ['pool', 'result'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });
  } catch {
    // HMR re-registration: prom-client throws on duplicate; reuse the existing one
    return client.register.getSingleMetric(PG_POOL_ACQUIRE_HISTOGRAM_NAME) as client.Histogram<
      'pool' | 'result'
    >;
  }
})();

const log = createLogger('pgDb', 'blue');

/**
 * Formats a value for SQL display/logging.
 * Used by combineSqlWithParams for consistent value formatting.
 */
function formatSqlValueForDisplay(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  } else if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  } else if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  } else if (typeof value === 'object') {
    return `'${JSON.stringify(value)}'`;
  }
  return String(value);
}

type CancellableResult<R extends QueryResultRow = any> = {
  query: Promise<QueryResult<R>>;
  result: () => Promise<R[]>;
  cancel: () => Promise<void>;
};
export type AugmentedPool = Pool & {
  cancellableQuery: <R extends QueryResultRow = any>(
    sql: Prisma.Sql | string,
    params?: any[]
  ) => Promise<CancellableResult<R>>;
};

type ClientInstanceType =
  | 'primary'
  | 'primaryRead'
  | 'primaryReadLong'
  | 'notification'
  | 'notificationRead'
  | 'datapacketRead'
  | 'apps';
const instanceUrlMap: Record<ClientInstanceType, string> = {
  notification: env.NOTIFICATION_DB_URL,
  notificationRead: env.NOTIFICATION_DB_REPLICA_URL ?? env.NOTIFICATION_DB_URL,
  primary: env.DATABASE_URL,
  primaryRead: env.DATABASE_REPLICA_URL ?? env.DATABASE_URL,
  primaryReadLong: env.DATABASE_REPLICA_LONG_URL ?? env.DATABASE_URL,
  datapacketRead: env.DATAPACKET_DATABASE_RO_URL ?? env.DATABASE_URL,
  // App Blocks KV datastore — empty string sentinel when unset. appsDb
  // never calls getClient unless APPS_DATABASE_URL is configured (see
  // src/server/db/appsDb.ts).
  apps: env.APPS_DATABASE_URL ?? '',
};

export function getClient(
  { instance }: { instance: ClientInstanceType } = {
    instance: 'primary',
  }
) {
  log(`Creating ${instance} client`);

  const envUrl = instanceUrlMap[instance];
  const connectionStringUrl = new URL(envUrl);
  if (env.DATABASE_SSL !== false) connectionStringUrl.searchParams.set('sslmode', 'no-verify');
  const connectionString = connectionStringUrl.toString();

  const isNotification = instance === 'notification' || instance === 'notificationRead';
  const appBaseName = isNotification
    ? 'notif-pg'
    : instance === 'datapacketRead'
    ? 'dp-read-pg'
    : instance === 'apps'
    ? 'apps-pg'
    : 'node-pg';

  // DO managed Postgres PgBouncer rejects statement_timeout as a startup parameter.
  // For notification instances, we set it per-connection via SET instead.
  const notifStatementTimeout =
    instance === 'notificationRead'
      ? (env.IS_DATAPACKET ? env.DATABASE_READ_TIMEOUT ?? 10000 : undefined)
      : instance === 'notification'
      ? env.DATABASE_WRITE_TIMEOUT
      : undefined;

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: env.IS_DATAPACKET
      ? env.DATABASE_CONNECTION_TIMEOUT || 5000
      : env.DATABASE_CONNECTION_TIMEOUT,
    min: 0,
    max: isNotification ? (env.NOTIFICATION_POOL_MAX ?? env.DATABASE_POOL_MAX) : env.DATABASE_POOL_MAX,
    // trying this for leaderboard job
    idleTimeoutMillis: instance === 'primaryReadLong' ? 300_000 : env.DATABASE_POOL_IDLE_TIMEOUT,
    statement_timeout:
      (isNotification || instance === 'datapacketRead') && env.IS_DATAPACKET
        ? undefined // DP: set per-connection below (PgBouncer ignores startup params)
        : instance === 'notificationRead'
        ? undefined // DOKS: standby doesn't support this
        : instance === 'primaryRead'
        ? env.DATABASE_READ_TIMEOUT
        : env.DATABASE_WRITE_TIMEOUT,
    application_name: `${appBaseName}${env.PODNAME ? '-' + env.PODNAME : ''}`,
  }) as AugmentedPool;

  // Set statement_timeout per-connection on DP instances that go through PgBouncer
  // (PgBouncer ignores statement_timeout as a startup parameter)
  if (env.IS_DATAPACKET && isNotification && notifStatementTimeout) {
    pool.on('connect', (client) => {
      client.query(`SET statement_timeout = ${Number(notifStatementTimeout)}`).catch(() => {});
    });
  }
  if (env.IS_DATAPACKET && instance === 'datapacketRead') {
    const readTimeout = env.DATABASE_READ_TIMEOUT ?? 120000; // 2 minutes default
    pool.on('connect', (client) => {
      client.query(`SET statement_timeout = ${Number(readTimeout)}`).catch(() => {});
    });
  }

  // Wrap pool.connect() to record acquire latency. The pg.Pool `acquire` event fires
  // when a client is handed out — it does NOT tell you how long the caller awaited.
  // Timing around the await is the only way to see queue-wait time, which is the
  // signal we want during pool-saturation incidents.
  //
  // pool.connect has two forms: Promise (no args) and callback ((err, client, done) => ...).
  // Pool.prototype.query uses the CALLBACK form internally, so any pool.query(...) caller
  // (including the /api/health probe) routes through here via that path. The async wrap
  // resolves immediately for the callback form (pg-pool returns undefined synchronously),
  // so we must wrap the callback itself to time when the client is actually delivered.
  const originalConnect = pool.connect.bind(pool) as typeof pool.connect;
  pool.connect = ((...args: Parameters<typeof pool.connect>) => {
    const start = performance.now();
    const elapsedSeconds = () => (performance.now() - start) / 1000;

    // Callback form: pool.connect((err, client, done) => ...)
    if (typeof args[0] === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cb = args[0] as (err: Error | undefined, client: any, done: any) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalConnect as any)((err: Error | undefined, client: any, done: any) => {
        pgPoolAcquireHistogram.observe(
          { pool: instance, result: err ? 'err' : 'ok' },
          elapsedSeconds()
        );
        cb(err, client, done);
      });
    }

    // Promise form: await pool.connect()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalConnect as any)(...args).then(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (conn: any) => {
        pgPoolAcquireHistogram.observe({ pool: instance, result: 'ok' }, elapsedSeconds());
        return conn;
      },
      (e: unknown) => {
        pgPoolAcquireHistogram.observe({ pool: instance, result: 'err' }, elapsedSeconds());
        throw e;
      }
    );
  }) as typeof pool.connect;

  pool.cancellableQuery = async function <R extends QueryResultRow = any>(
    sql: Prisma.Sql | string,
    params?: any[]
  ) {
    const connection = await pool.connect();
    // Use the connection's processID property instead of an extra query
    // This is set when the connection is established by the pg library
    const pid = (connection as any).processID as number;

    let queryText: string;
    let queryParams: any[] | undefined;

    if (typeof sql === 'object') {
      // Prisma.Sql object
      queryText = sql.text;
      queryParams = sql.values;
      for (const i in queryParams) queryParams[i] = formatSqlType(queryParams[i]);
    } else if (params !== undefined) {
      // Plain string with parameters
      queryText = sql;
      queryParams = params;
    } else {
      // Plain string without parameters
      queryText = sql;
      queryParams = undefined;
    }

    // Logging
    log(instance, combineSqlWithParams(sql));

    let done = false;
    const query =
      queryParams !== undefined
        ? connection.query<R>(queryText, queryParams)
        : connection.query<R>(queryText);
    query.finally(() => {
      done = true;
      connection.release();
    });

    const cancel = async () => {
      if (done) return;
      const cancelConnection = await pool.connect();
      await cancelConnection.query('SELECT pg_cancel_backend($1)', [pid]);
      cancelConnection.release();
      done = true;
    };
    const result = async () => {
      const { rows } = await query;
      return rows;
    };

    return { query, result, cancel };
  };

  return pool;
}

/**
 * Run a read-only query against the given pool with a server-side
 * `statement_timeout` ceiling. Uses an explicit BEGIN READ ONLY / SET LOCAL
 * / COMMIT so the timeout is scoped to this transaction even under PgBouncer
 * transaction pooling.
 *
 * Accepts either a Prisma.Sql (preferred — the codebase's raw-query convention)
 * or a (text, params) pair, matching the shape of pg's `Pool.query`.
 *
 * Throws pg error with code `'57014'` (query_canceled) on timeout — callers
 * should catch and decide whether to surface, return an empty page, or retry.
 *
 * Note: `timeoutMs` is interpolated literally because PostgreSQL does not
 * accept `$1`-parameterized values in `SET LOCAL`. The argument MUST be a
 * trusted JS number — never user input. `Number(...)` is a defensive cast.
 */
export async function queryWithTimeout<R extends QueryResultRow = any>(
  pool: Pool,
  timeoutMs: number,
  sql: Prisma.Sql | string,
  params?: ReadonlyArray<unknown>
): Promise<QueryResult<R>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    let result: QueryResult<R>;
    if (typeof sql === 'string') {
      result = await client.query<R>(sql, params as unknown[] | undefined);
    } else {
      // Prisma.Sql carries its own params in `.values`; pass as QueryConfig
      result = await client.query<R>({ text: sql.text, values: sql.values });
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

function formatSqlType(value: any): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map(formatSqlType).join(',');
    }
    if (value === null) return 'null';
    return JSON.stringify(value);
  }
  return value;
}

export function templateHandler<T>(fn: (value: string) => Promise<T> | T) {
  return function (sql: TemplateStringsArray, ...values: any[]) {
    const sqlString = sql.reduce((acc, part, i) => acc + part + formatSqlType(values[i] ?? ''), '');
    return fn(sqlString);
  };
}

export function parameterizedTemplateHandler<T>(
  fn: (sql: string, params: any[]) => Promise<T> | T
) {
  return function (sql: TemplateStringsArray, ...values: any[]) {
    const params: any[] = [];
    const sqlString = sql.reduce((acc, part, i) => {
      acc += part;
      let value = values[i];
      if (value === undefined) return acc;
      if (typeof value === 'string') return acc + value;

      // Determine if this should be treated as JSONB based on SQL context
      const nextPart = sql[i + 1] || '';
      const isJsonbContext = nextPart.includes('::jsonb') || nextPart.includes('::json');

      // For JSONB contexts, stringify the object/array
      if (typeof value === 'object' && isJsonbContext) value = JSON.stringify(value);

      params.push(value);
      acc += `$${params.length}`;
      return acc;
    }, '');
    return fn(sqlString, params);
  };
}

function lsnGTE(lsn1: string, lsn2: string): boolean {
  const [a1, b1] = lsn1.split('/').map((part) => parseInt(part, 16));
  const [a2, b2] = lsn2.split('/').map((part) => parseInt(part, 16));
  return a1 > a2 || (a1 === a2 && b1 >= b2);
}

export async function getCurrentLSN() {
  try {
    const currentRes = await dbWrite.$queryRaw<
      {
        lsn: string;
      }[]
    >`SELECT pg_current_wal_lsn()::text AS lsn`;
    return currentRes[0]?.lsn ?? '';
  } catch (e) {
    // TODO what to return here
    return '';
  }
}

export async function checkNotUpToDate(lsn: string) {
  try {
    const roRes = await dbWrite.$queryRaw<
      { replay_lsn: string }[]
    >`SELECT replay_lsn::text FROM get_replication_status() where application_name like 'ro-c16-%'`;
    return roRes.some((row) => !lsnGTE(row.replay_lsn, lsn));
  } catch (e) {
    return true;
  }
}

export type RunContext = {
  cancelFns: (() => Promise<void>)[];
  batchSize: number;
  concurrency: number;
  start: number;
  end?: number;
  after?: Date;
  before?: Date;
};

type DataProcessorOptions = {
  rangeFetcher: (context: RunContext) => Promise<{ start: number; end: number }>;
  processor: (context: Omit<RunContext, 'end'> & { end: number }) => Promise<void>;
  enableLogging?: boolean;
  runContext: {
    on: (event: 'close', listener: () => void) => void;
  };
  params: {
    batchSize: number;
    concurrency: number;
    start: number;
    end?: number;
    after?: Date;
    before?: Date;
  };
};

export async function dataProcessor({
  rangeFetcher,
  processor,
  runContext,
  params,
}: DataProcessorOptions) {
  const cancelFns: (() => Promise<void>)[] = [];
  let stop = false;
  runContext.on('close', async () => {
    console.log('Cancelling');
    stop = true;
    await Promise.all(cancelFns.map((cancel) => cancel()));
  });

  const { start = 1, end, batchSize, concurrency } = params;
  const context = { ...params, cancelFns };

  if (stop) return;
  const range =
    start === undefined || end === undefined ? await rangeFetcher(context) : { start, end };

  let cursor = range.start ?? params.start;
  const maxCursor = range.end;
  await limitConcurrency(() => {
    if (stop || cursor > maxCursor) return null;
    const start = cursor;
    cursor = Math.min(cursor + batchSize, maxCursor);
    const end = cursor;
    cursor++; // To avoid batch overlap

    return async () => {
      try {
        await processor({ ...context, start, end });
      } catch (e) {
        console.log({ start, end, message: (e as Error).message });
      }
    };
  }, concurrency);
}

export type BatchRunContext = {
  cancelFns: (() => Promise<void>)[];
  batchSize: number;
  concurrency: number;
};
type BatchProcessorOptions = {
  batchFetcher: (context: BatchRunContext) => Promise<number[]>;
  processor: (
    context: BatchRunContext & { batch: number[]; batchNumber: number; batchCount: number }
  ) => Promise<void>;
  enableLogging?: boolean;
  runContext: {
    on: (event: 'close', listener: () => void) => void;
  };
  params: {
    batchSize: number;
    concurrency: number;
    ids?: number[];
    start?: number;
    end?: number;
  };
};

export async function batchProcessor({
  batchFetcher,
  processor,
  runContext,
  params,
}: BatchProcessorOptions) {
  const cancelFns: (() => Promise<void>)[] = [];
  let stop = false;
  runContext.on('close', async () => {
    console.log('Cancelling');
    stop = true;
    await Promise.all(cancelFns.map((cancel) => cancel()));
  });

  const { batchSize, concurrency } = params;
  let { ids } = params;
  if (stop) return;
  const context = { ...params, cancelFns };
  ids ??= await batchFetcher(context);

  let cursor = params.start ?? 0;
  const batchCount = params.end ?? Math.ceil(ids.length / batchSize);
  await limitConcurrency(() => {
    if (stop || cursor >= batchCount) return null;
    const start = cursor;
    cursor++;
    const end = cursor;

    const batch = ids.slice(start * batchSize, end * batchSize);
    const batchNumber = cursor;
    return async () => {
      await processor({ ...context, batch, batchNumber, batchCount });
    };
  }, concurrency);
}

/**
 * Combines a SQL string with its parameters for display/logging.
 * Replaces $1, $2 (and :1, :2) placeholders with formatted values.
 * NOTE: This is for logging/debugging only, not for executing queries.
 */
export function combineSqlWithParams(sql: string | Prisma.Sql, params?: readonly unknown[]) {
  const queryText = typeof sql === 'string' ? sql : sql.text;
  const queryParams = params ?? (typeof sql === 'string' ? [] : sql.values);

  let query = queryText;
  for (let i = 0; i < queryParams.length; i++) {
    // Negative lookahead for no more numbers, ie. replace $1 in '$1' but not '$11'
    const re = new RegExp('([$:])' + (i + 1) + '(?!\\d)', 'g');
    const formatted = formatSqlValueForDisplay(queryParams[i]);
    query = query.replace(re, formatted);
  }
  return query;
}

export function getExplainSql(value: typeof Prisma.Sql) {
  return combineSqlWithParams(Prisma.sql`
    EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON)
    ${value}
  `);
}

/**
 * Helper function to safely encode JSON data for use in SQL queries.
 * This properly escapes the JSON and wraps it in quotes for PostgreSQL.
 *
 * @param data - The data to encode as JSON
 * @returns A string that can be safely interpolated into SQL as JSONB
 *
 * @example
 * const metrics = await ctx.db.$queryRaw<{ data: any }[]>`...`;
 * if (metrics?.[0]?.data) {
 *   await executeRefresh(ctx)`
 *     SELECT * FROM jsonb_array_elements(${jsonbArrayFrom(metrics[0].data)})
 *   `;
 * }
 */
export function jsonbArrayFrom(data: any): string {
  return `'${JSON.stringify(data)}'::jsonb`;
}

export const dbKV = {
  get: async function <T>(key: string, defaultValue?: T) {
    const stored = await dbWrite.keyValue.findUnique({ where: { key } });
    return stored ? (stored.value as T) : defaultValue;
  },
  set: async function <T>(key: string, value: T) {
    const json = JSON.stringify(value).replace(/'/g, "''");
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "KeyValue" ("key", "value")
      VALUES ('${key}', '${json}'::jsonb)
      ON CONFLICT ("key")
      DO UPDATE SET "value" = '${json}'::jsonb
    `);
  },
};
