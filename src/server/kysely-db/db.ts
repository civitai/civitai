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

type Target = keyof typeof targets;
function createKyselyDb(target: Target, log?: typeof logQuery) {
  const dbUrl = targets[target];
  const dialect = new PostgresDialect({
    pool: !isProd
      ? new Pool({
          // connectionString: dbUrl.substring(0, dbUrl.indexOf('?')),
          // ssl: {
          //   rejectUnauthorized: true,
          //   ca: fs.readFileSync(path.resolve(process.cwd(), './ca-certificate.crt')).toString(),
          // },
          connectionString: dbUrl.substring(0, dbUrl.indexOf('?')),
          ssl: { rejectUnauthorized: false },
        })
      : new Pool({ connectionString: dbUrl }),
  });

  return new Kysely<DB>({
    dialect,
    plugins: [new ParseJSONResultsPlugin()],
    log: (event) => log?.(event, target),
  });
}

function logQuery(event: LogEvent, target: Target) {
  if (isProd && event.queryDurationMillis < 2000) return;
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
  if (!isProd) {
    logQueryEventToDb(event);
  } else {
    // logToAxiom({ query, duration: event.queryDurationMillis, target }, 'db-logs');
  }
}

const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
export const kyselyDbWrite = createKyselyDb('write', logQuery);
export const kyselyDbRead = singleClient ? kyselyDbWrite : createKyselyDb('read', logQuery);

const logDb = createKyselyDb('write', (event, target) => {
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
