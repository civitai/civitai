// src/server/db/client.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalDbRead: PrismaClient | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalDbWrite: PrismaClient | undefined;
}

async function logQuery(e: { query: string; params: string; duration: number }) {
  if (e.duration < 2000) return;
  let query = e.query;
  const params = JSON.parse(e.params);
  // Replace $X variables with params in query so it's possible to copy/paste and optimize
  for (let i = 0; i < params.length; i++) {
    // Negative lookahead for no more numbers, ie. replace $1 in '$1' but not '$11'
    const re = new RegExp('\\$' + ((i as number) + 1) + '(?!\\d)', 'g');
    // If string, will quote - if bool or numeric, will not - does the job here
    if (typeof params[i] === 'string') params[i] = "'" + params[i].replace("'", "\\'") + "'";
    //params[i] = JSON.stringify(params[i])
    query = query.replace(re, params[i]);
  }

  if (!isProd) console.log(query);
  else await logToAxiom({ query, duration: e.duration, pod: env.PODNAME }, 'db-logs');
}

const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
const createPrismaClient = ({ readonly }: { readonly: boolean }) => {
  const log: Prisma.LogDefinition[] = env.LOGGING.filter((x) => x.startsWith('prisma:')).map(
    (x) => ({
      emit: 'stdout',
      level: x.replace('prisma:', '') as Prisma.LogLevel,
    })
  );
  if (env.LOGGING.some((x) => x.includes('prisma-slow'))) {
    const existingItemIndex = log.findIndex((x) => x.level === 'query');
    log.splice(existingItemIndex, 1);
    log.push({
      emit: 'event',
      level: 'query',
    });
  }
  const dbUrl = readonly ? env.DATABASE_REPLICA_URL : env.DATABASE_URL;
  const prisma = new PrismaClient({ log, datasources: { db: { url: dbUrl } } });
  return prisma;
};

export let dbRead: PrismaClient;
export let dbWrite: PrismaClient;

if (isProd) {
  dbWrite = createPrismaClient({ readonly: false });
  dbRead = singleClient ? dbWrite : createPrismaClient({ readonly: true });
} else {
  if (!global.globalDbWrite) {
    global.globalDbWrite = createPrismaClient({ readonly: false });

    // @ts-ignore - this is necessary to get the query event
    if (env.LOGGING.includes('prisma-slow-write')) global.globalDbWrite.$on('query', logQuery);
  }
  if (!global.globalDbRead) {
    global.globalDbRead = singleClient
      ? global.globalDbWrite
      : createPrismaClient({ readonly: true });

    // @ts-ignore - this is necessary to get the query event
    if (env.LOGGING.includes('prisma-slow-read')) global.globalDbRead.$on('query', logQuery);
  }
  dbWrite = global.globalDbWrite;
  dbRead = singleClient ? dbWrite : global.globalDbRead;
}
