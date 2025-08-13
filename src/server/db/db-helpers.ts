import { Prisma } from '@prisma/client';
import type { QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('pgDb', 'blue');

type CancellableResult<R extends QueryResultRow = any> = {
  query: Promise<QueryResult<R>>;
  result: () => Promise<R[]>;
  cancel: () => Promise<void>;
};
export type AugmentedPool = Pool & {
  cancellableQuery: <R extends QueryResultRow = any>(
    sql: Prisma.Sql | string
  ) => Promise<CancellableResult<R>>;
};

type ClientInstanceType =
  | 'primary'
  | 'primaryRead'
  | 'primaryReadLong'
  | 'notification'
  | 'notificationRead'
  | 'logicalReplica';
const instanceUrlMap: Record<ClientInstanceType, string> = {
  notification: env.NOTIFICATION_DB_URL,
  notificationRead: env.NOTIFICATION_DB_REPLICA_URL ?? env.NOTIFICATION_DB_URL,
  primary: env.DATABASE_URL,
  primaryRead: env.DATABASE_REPLICA_URL ?? env.DATABASE_URL,
  primaryReadLong: env.DATABASE_REPLICA_LONG_URL ?? env.DATABASE_URL,
  logicalReplica: env.LOGICAL_REPLICA_DB_URL ?? env.DATABASE_URL,
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
    : instance === 'logicalReplica'
    ? 'logical-pg'
    : 'node-pg';

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT,
    min: 0,
    max: env.DATABASE_POOL_MAX,
    // trying this for leaderboard job
    idleTimeoutMillis: instance === 'primaryReadLong' ? 300_000 : env.DATABASE_POOL_IDLE_TIMEOUT,
    statement_timeout:
      instance === 'notificationRead'
        ? undefined // standby seems to not support this
        : instance === 'primaryRead'
        ? env.DATABASE_READ_TIMEOUT
        : env.DATABASE_WRITE_TIMEOUT,
    application_name: `${appBaseName}${env.PODNAME ? '-' + env.PODNAME : ''}`,
  }) as AugmentedPool;

  pool.cancellableQuery = async function <R extends QueryResultRow = any>(
    sql: Prisma.Sql | string
  ) {
    const connection = await pool.connect();
    const pidQuery = await connection.query('SELECT pg_backend_pid()');
    const pid = pidQuery.rows[0].pg_backend_pid;

    // Fix dates
    if (typeof sql === 'object') {
      for (const i in sql.values) sql.values[i] = formatSqlType(sql.values[i]);
    }

    // Logging
    log(instance, sql);

    let done = false;
    const query = connection.query<R>(sql);
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

export function combineSqlWithParams(sql: string, params: readonly unknown[]) {
  let query = sql;
  const parameters = params as string[];
  for (let i = 0; i < parameters.length; i++) {
    // Negative lookahead for no more numbers, ie. replace $1 in '$1' but not '$11'
    const re = new RegExp('([$:])' + (i + 1) + '(?!\\d)', 'g');
    // If string, will quote - if bool or numeric, will not - does the job here
    if (typeof parameters[i] === 'string')
      parameters[i] = "'" + parameters[i].replace("'", "\\'") + "'";
    //params[i] = JSON.stringify(params[i])
    query = query.replace(re, parameters[i]);
  }
  return query;
}

export function getExplainSql(value: typeof Prisma.Sql) {
  const obj = Prisma.sql`
    EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON)
    ${value}
  `;
  return combineSqlWithParams(obj.text, obj.values);
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

const DEFAULT_LOCK_TIMEOUT_MS = 250; // 250-500ms is a good default
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 150;

function isLockTimeout(err: any) {
  // Postgres codes: 55P03 = lock_not_available (incl. lock_timeout), 57014 = query_canceled
  return (
    err?.code === '55P03' || err?.code === '57014' || /lock timeout/i.test(String(err?.message))
  );
}

export interface RetryLockOptions {
  lockTimeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

/**
 * Executes a Prisma transaction with automatic retry on lock timeout.
 * This helps avoid long waits when tables are locked by setting a short timeout
 * and retrying with exponential backoff.
 *
 * @param dbClient - Prisma database client
 * @param transaction - The transaction function to execute
 * @param options - Configuration options for retry behavior
 * @returns The result of the transaction
 *
 * @example
 * await retryLock(dbWrite, async (tx) => {
 *   await tx.$queryRaw`
 *     INSERT INTO "MyTable" (col1, col2) VALUES ${values}
 *     ON CONFLICT (col1) DO UPDATE SET col2 = EXCLUDED.col2
 *   `;
 * });
 */
export async function retryLock<T>(
  dbClient: any,
  transaction: (tx: any) => Promise<T>,
  options: RetryLockOptions = {}
): Promise<T> {
  const {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
  } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await dbClient.$transaction(async (tx: any) => {
        // Set lock timeout for this transaction
        // Parameters aren't allowed in SET, so inline literal is safe here
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);

        // Execute the actual transaction
        return await transaction(tx);
      });
    } catch (err: any) {
      if (isLockTimeout(err) && attempt < maxRetries) {
        // Exponential backoff before retry
        const backoff = backoffMs * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw err;
    }
  }

  // This should never be reached due to the throw in the catch block
  throw new Error('Max retries exceeded');
}

export const dbKV = {
  get: async function <T>(key: string, defaultValue?: T) {
    const stored = await dbWrite.keyValue.findUnique({ where: { key } });
    return stored ? (stored.value as T) : defaultValue;
  },
  set: async function <T>(key: string, value: T) {
    const json = JSON.stringify(value);
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "KeyValue" ("key", "value")
      VALUES ('${key}', '${json}'::jsonb)
      ON CONFLICT ("key")
      DO UPDATE SET "value" = '${json}'::jsonb
    `);
  },
};
