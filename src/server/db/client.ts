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
  const log: Prisma.LogLevel[] = isProd
    ? ['error']
    : env.LOGGING.filter((x) => x.startsWith('prisma:')).map(
        (x) => x.replace('prisma:', '') as Prisma.LogLevel
      );
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
  if (!global.globalDbWrite) global.globalDbWrite = createPrismaClient({ readonly: false });
  if (!global.globalDbRead) {
    global.globalDbRead = singleClient
      ? global.globalDbWrite
      : createPrismaClient({ readonly: true });
  }
  dbWrite = global.globalDbWrite;
  dbRead = singleClient ? dbWrite : global.globalDbRead;
}
