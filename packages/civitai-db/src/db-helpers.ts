import { Prisma } from '@civitai/db-schema';
import type { QueryResult, QueryResultRow } from 'pg';
import { Pool, types } from 'pg';
import { performance } from 'node:perf_hooks';
import client from 'prom-client';
import { type DbLogFn } from './env';
import { limitConcurrency } from './concurrency-helpers';

// Fix Dates: TIMESTAMP comes back as a UTC Date (was set per-pool-module in the app).
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

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

export type CreatePoolOptions = {
  /** Postgres connection string. `sslmode=no-verify` is appended unless `ssl: false`. */
  connectionString: string;
  /** Prometheus `pool` label for acquire-latency metrics + the "Creating <label> client" log line. */
  label?: string;
  /** Postgres `application_name` (shows in pg_stat_activity). */
  applicationName?: string;
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Startup `statement_timeout` (ms). Omit for PgBouncer-fronted pools, which reject it as a startup
   * param — use `perConnectionStatementTimeout` there instead. */
  statementTimeout?: number;
  /** If set, `SET statement_timeout` per-connection on `connect` — for PgBouncer, which ignores the
   * startup param. */
  perConnectionStatementTimeout?: number;
  /** Default true → append `sslmode=no-verify`. */
  ssl?: boolean;
  log?: DbLogFn;
};

/**
 * Build one augmented pg pool from an explicit connection string + pool tuning. This is the shared
 * core: it owns the `cancellableQuery` augmentation, the connect-latency metric wrap, and the SSL/param
 * wiring. `getClient` (env/instance-driven, monolith-facing) and `createClients` (connection-string,
 * app-facing) both delegate here so there is exactly one pool implementation.
 */
export function createPool(options: CreatePoolOptions): AugmentedPool {
  const {
    connectionString: rawUrl,
    label = 'node-pg',
    applicationName,
    max = 20,
    min = 0,
    idleTimeoutMillis = 30_000,
    connectionTimeoutMillis = 0,
    statementTimeout,
    perConnectionStatementTimeout,
    ssl = true,
    log: logOption,
  } = options;
  const log: DbLogFn = logOption ?? (() => {});

  log(`Creating ${label} client`);

  const connectionStringUrl = new URL(rawUrl);
  if (ssl !== false) connectionStringUrl.searchParams.set('sslmode', 'no-verify');
  const connectionString = connectionStringUrl.toString();

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis,
    min,
    max,
    idleTimeoutMillis,
    statement_timeout: statementTimeout,
    application_name: applicationName,
  }) as AugmentedPool;

  // Per-connection statement_timeout for PgBouncer-fronted pools (which ignore the startup param).
  if (perConnectionStatementTimeout) {
    pool.on('connect', (client) => {
      client.query(`SET statement_timeout = ${Number(perConnectionStatementTimeout)}`).catch(() => {});
    });
  }

  // Wrap pool.connect() to record acquire latency. The pg.Pool `acquire` event fires when a client is
  // handed out — it does NOT tell you how long the caller awaited. Timing around the await is the only
  // way to see queue-wait time, which is the signal we want during pool-saturation incidents.
  //
  // pool.connect has two forms: Promise (no args) and callback ((err, client, done) => ...). Pool.query
  // uses the CALLBACK form internally, so any pool.query(...) caller (incl. the /api/health probe)
  // routes through here via that path. The async wrap resolves immediately for the callback form
  // (pg-pool returns undefined synchronously), so we must wrap the callback itself to time when the
  // client is actually delivered.
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
        pgPoolAcquireHistogram.observe({ pool: label, result: err ? 'err' : 'ok' }, elapsedSeconds());
        cb(err, client, done);
      });
    }

    // Promise form: await pool.connect()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalConnect as any)(...args).then(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (conn: any) => {
        pgPoolAcquireHistogram.observe({ pool: label, result: 'ok' }, elapsedSeconds());
        return conn;
      },
      (e: unknown) => {
        pgPoolAcquireHistogram.observe({ pool: label, result: 'err' }, elapsedSeconds());
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
    log(`${label}`, combineSqlWithParams(sql));

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

export type CreateClientsOptions = Omit<CreatePoolOptions, 'connectionString'> & {
  /** Write (primary) connection string. */
  writeUrl: string;
  /** Read (replica) connection string. Omit — or pass the same value as `writeUrl` — for a single-DB
   * setup, in which case `read` aliases `write` (one pool, no second connection). */
  readUrl?: string;
};

export type ReadWriteClients = {
  /** The write pool. Built + memoized on first access. */
  write: () => AugmentedPool;
  /** The read pool — aliases `write` when `readUrl` is omitted or equals `writeUrl`. */
  read: () => AugmentedPool;
};

/**
 * Build a read/write pool pair from explicit connection strings — the app-facing seam for
 * "give me DB access" without knowing about the monolith's env-driven `ClientInstanceType` map. Any app
 * passes its own connection strings (typically straight from env) plus optional pool tuning; single-DB
 * setups omit `readUrl` and get one shared pool.
 *
 * Both accessors are LAZY + memoized — nothing builds a pool (or parses a URL) until first called, so
 * importing a shim that calls this never connects (build / typecheck / no-DB tests stay safe).
 */
export function createClients(options: CreateClientsOptions): ReadWriteClients {
  const { writeUrl, readUrl, ...poolOptions } = options;
  let write: AugmentedPool | undefined;
  let read: AugmentedPool | undefined;

  const getWrite = () => (write ??= createPool({ ...poolOptions, connectionString: writeUrl }));
  const getRead = () =>
    (read ??=
      !readUrl || readUrl === writeUrl
        ? getWrite()
        : createPool({ ...poolOptions, connectionString: readUrl }));

  return { write: getWrite, read: getRead };
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

// getCurrentLSN / checkNotUpToDate / dbKV moved to ./kv-helpers (they need a Prisma
// client; the app shim binds dbWrite and re-exports them under the same names).

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
