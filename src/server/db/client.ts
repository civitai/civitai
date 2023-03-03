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
  dbRead = createPrismaClient({ readonly: true });
  dbWrite = createPrismaClient({ readonly: false });
} else {
  if (!global.globalDbRead) global.globalDbRead = createPrismaClient({ readonly: true });
  if (!global.globalDbWrite) global.globalDbWrite = createPrismaClient({ readonly: false });
  dbRead = global.globalDbRead;
  dbWrite = global.globalDbWrite;
}
