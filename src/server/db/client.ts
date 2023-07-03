// src/server/db/client.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { isProd } from '~/env/other';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalDbRead: PrismaClient | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalDbWrite: PrismaClient | undefined;
}

const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
const createPrismaClient = ({ readonly }: { readonly: boolean }) => {
  const log = [
    {
      emit: 'event' as const,
      level: 'query' as const,
    },
    {
      emit: 'stdout' as const,
      level: 'warn' as const,
    },
  ] as const;
  // : env.LOGGING.filter((x) => x.startsWith('prisma:')).map(
  //     (x) => x.replace('prisma:', '') as Prisma.LogLevel
  //   );
  const dbUrl = readonly ? env.DATABASE_REPLICA_URL : env.DATABASE_URL;
  // @ts-ignore: just for debugging purposes, comment this out
  const prisma = new PrismaClient({ log, datasources: { db: { url: dbUrl } } });

  // Uncomment to log full queries
  // @ts-ignore: just for debugging purposes, comment this out
  prisma.$on('query', async (e: Prisma.QueryEvent) => {
    // If something took a long time
    if (e.duration > 2000) {
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

      console.log(query);
    }
  });

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
  }
  if (!global.globalDbRead) {
    global.globalDbRead = singleClient
      ? global.globalDbWrite
      : createPrismaClient({ readonly: true });
  }
  dbWrite = global.globalDbWrite;
  dbRead = singleClient ? dbWrite : global.globalDbRead;
}
