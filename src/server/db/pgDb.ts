import { Prisma } from '@prisma/client';
import { Pool, QueryResult, QueryResultRow, types } from 'pg';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';

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

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgRead: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgWrite: AugmentedPool | undefined;
}

function getClient({ readonly }: { readonly: boolean } = { readonly: false }) {
  console.log('Creating PG client');
  const connectionStringUrl = new URL(readonly ? env.DATABASE_REPLICA_URL : env.DATABASE_URL);
  connectionStringUrl.searchParams.set('sslmode', 'no-verify');
  const connectionString = connectionStringUrl.toString();

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: env.DATABASE_POOL_IDLE_TIMEOUT,
  }) as AugmentedPool;

  pool.cancellableQuery = async function <R extends QueryResultRow = any>(
    sql: Prisma.Sql | string
  ) {
    const connection = await pool.connect();
    const pidQuery = await connection.query('SELECT pg_backend_pid()');
    const pid = pidQuery.rows[0].pg_backend_pid;

    // Fix dates
    if (typeof sql === 'object') {
      for (const i in sql.values) {
        if (sql.values[i] instanceof Date) sql.values[i] = (sql.values[i] as Date).toISOString();
      }
    }

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

// Fix Dates
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

export let pgDbWrite: AugmentedPool;
export let pgDbRead: AugmentedPool;
const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
if (isProd) {
  pgDbWrite = getClient();
  pgDbRead = singleClient ? pgDbWrite : getClient({ readonly: true });
} else {
  if (!global.globalPgWrite) global.globalPgWrite = getClient();
  if (!global.globalPgRead)
    global.globalPgRead = singleClient ? global.globalPgWrite : getClient({ readonly: true });
  pgDbWrite = global.globalPgWrite;
  pgDbRead = global.globalPgRead;
}
