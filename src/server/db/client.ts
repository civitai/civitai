// src/server/db/client.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { isProd } from '~/env/other';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var dbRead: PrismaClient | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var dbWrite: PrismaClient | undefined;
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
  if (!global.dbRead) global.dbRead = createPrismaClient({ readonly: true });
  if (!global.dbWrite) global.dbWrite = createPrismaClient({ readonly: false });
  dbRead = global.dbRead;
  dbWrite = global.dbWrite;
}
