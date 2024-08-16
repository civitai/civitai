import { DB } from './types'; // this is the Database interface we defined earlier
import { Pool, types } from 'pg';
import { Kysely, LogEvent, ParseJSONResultsPlugin, PostgresDialect, sql } from 'kysely';
import { env } from '~/env/server.mjs';
import fs from 'fs';
import path from 'path';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import crypto from 'crypto';
import { redis } from '~/server/redis/client';

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
    pool: new Pool({
      connectionString: dbUrl.substring(0, dbUrl.indexOf('?')),
      ssl: {
        rejectUnauthorized: true,
        ca: fs.readFileSync(path.resolve(process.cwd(), './ca-certificate.crt')).toString(),
      },
    }),
  });

  return new Kysely<DB>({
    dialect,
    plugins: [new ParseJSONResultsPlugin()],
    log: (event) => log?.(event, target),
  });
}

async function logQuery(event: LogEvent, target: Target) {
  // if (isProd && event.queryDurationMillis < 2000) return;
  // if (event.level === 'error') {
  //   //TODO
  // }
  // let query = event.query.sql;
  // const parameters = event.query.parameters as string[];
  // for (let i = 0; i < parameters.length; i++) {
  //   // Negative lookahead for no more numbers, ie. replace $1 in '$1' but not '$11'
  //   const re = new RegExp('\\$' + ((i as number) + 1) + '(?!\\d)', 'g');
  //   // If string, will quote - if bool or numeric, will not - does the job here
  //   if (typeof parameters[i] === 'string')
  //     parameters[i] = "'" + parameters[i].replace("'", "\\'") + "'";
  //   //params[i] = JSON.stringify(params[i])
  //   query = query.replace(re, parameters[i]);
  // }
  // if (!isProd) {
  //   // logDbEventToRedis(event);
  // } else {
  //   logToAxiom({ query, duration: event.queryDurationMillis, target }, 'db-logs');
  // }
}

const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
export const kyselyDbWrite = createKyselyDb('write', logQuery);
export const kyselyDbRead = singleClient ? kyselyDbWrite : createKyselyDb('read', logQuery);

const logDb = createKyselyDb('write');

// async function logDbEventToRedis(event: LogEvent) {
//   const stringParams = JSON.stringify(event.query.parameters);
//   const sqlHash = crypto.createHash('sha256').update(event.query.sql).digest('hex');
//   const paramsHash = crypto.createHash('sha256').update(stringParams).digest('hex');

//   const sqlKey = `db:sql:${sqlHash}`;
//   const paramsKey = `db:sql:${sqlHash}:${paramsHash}`;

//   const sqlCache = await redis.get(sqlKey);
//   if (!sqlCache) await redis.set(sqlKey, JSON.stringify(event.query.sql));

//   const paramsCache = await redis.get(paramsKey);
//   const data = !paramsCache
//     ? { params: event.query.parameters, duration: [] }
//     : JSON.parse(paramsCache);
//   data.duration.push(event.queryDurationMillis);
//   await redis.set(paramsKey, JSON.stringify(data));
// }
