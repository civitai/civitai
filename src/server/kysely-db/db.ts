import { DB } from './types'; // this is the Database interface we defined earlier
import { Pool, types } from 'pg';
import { Kysely, LogEvent, ParseJSONResultsPlugin, PostgresDialect } from 'kysely';
import { env } from '~/env/server.mjs';
import fs from 'fs';
import path from 'path';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import crypto from 'crypto';

types.setTypeParser(types.builtins.NUMERIC, function (val) {
  return parseFloat(val);
});

types.setTypeParser(types.builtins.INT8, function (val) {
  return parseFloat(val);
});

const targets = {
  read: env.DATABASE_REPLICA_URL,
  write: env.DATABASE_URL,
};

// TODO - implement a lazy db connection

function createDbConnection({ log, pool }: { log?: typeof logQuery; pool: Pool }) {
  const dialect = new PostgresDialect({ pool });

  return new Kysely<DB>({
    dialect,
    plugins: [new ParseJSONResultsPlugin()],
    log: (event) => log?.(event),
  });
}

function createPool(target: keyof typeof targets) {
  const dbUrl = targets[target];
  return new Pool({
    // connectionString: dbUrl.substring(0, dbUrl.indexOf('?')),
    // ssl: {
    //   rejectUnauthorized: true,
    //   ca: fs.readFileSync(path.resolve(process.cwd(), './ca-certificate.crt')).toString(),
    // },
    connectionString: dbUrl.substring(0, dbUrl.indexOf('?')),
    ssl: { rejectUnauthorized: false },
  });
}

const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
const writePool = createPool('write');
const readPool = singleClient ? writePool : createPool('read');

function logQuery(event: LogEvent) {
  if (event.level === 'error') {
    if (!isProd) {
      console.error('Query failed : ', {
        durationMs: event.queryDurationMillis,
        error: event.error,
        sql: event.query.sql,
        params: event.query.parameters,
      });
    }
  }
  if (event.queryDurationMillis > 250) {
    logQueryEventToDb(event);
  }
}

export const kyselyDbWrite = createDbConnection({ pool: writePool, log: logQuery });
export const kyselyDbRead = createDbConnection({ pool: readPool, log: logQuery });
const logDb = createDbConnection({
  pool: writePool,
  log: (event) => {
    if (event.level === 'error') {
      if (!isProd) {
        console.error('Query failed : ', {
          durationMs: event.queryDurationMillis,
          error: event.error,
          sql: event.query.sql,
          params: event.query.parameters,
        });
      }
    } else {
      if (!isProd) {
        // console.log(combineSqlWithParams(event.query.sql, event.query.parameters));
        // TODO - log link to view query details
      }
    }
  },
});

async function logQueryEventToDb(event: LogEvent) {
  const stringParams = JSON.stringify(event.query.parameters);
  const sqlHash = crypto.createHash('sha256').update(event.query.sql).digest('hex');
  const paramsHash = crypto.createHash('sha256').update(stringParams).digest('hex');

  const { id: sqlId } = await logDb
    .with('e', (db) =>
      db
        .insertInto('QuerySqlLog')
        .values({ hash: sqlHash, sql: event.query.sql })
        .onConflict((oc) => oc.doNothing())
        .returning(['id'])
    )
    .selectFrom('e')
    .selectAll()
    .union(logDb.selectFrom('QuerySqlLog').select(['id']).where('hash', '=', sqlHash))
    .executeTakeFirstOrThrow();

  const { id: paramsId } = await logDb
    .with('e', (db) =>
      db
        .insertInto('QueryParamsLog')
        .values({ sqlId, hash: paramsHash, params: JSON.stringify(event.query.parameters) })
        .onConflict((oc) => oc.doNothing())
        .returning(['id'])
    )
    .selectFrom('e')
    .selectAll()
    .union(
      logDb
        .selectFrom('QueryParamsLog')
        .select(['id'])
        .where(({ and, eb }) => and([eb('sqlId', '=', sqlId), eb('hash', '=', paramsHash)]))
    )
    .executeTakeFirstOrThrow();

  await logDb
    .insertInto('QueryDurationLog')
    .values({ sqlId, paramsId, duration: Math.round(event.queryDurationMillis) })
    .execute();
}
