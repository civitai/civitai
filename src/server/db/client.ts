// src/server/db/client.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '~/env/server.mjs';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var prisma: PrismaClient | undefined;
}

export let prisma: PrismaClient;
if (env.NODE_ENV === 'production') {
  prisma = new PrismaClient({ log: ['error'] });
} else {
  if (!global.prisma) {
    const log = env.LOGGING.filter((x) => x.startsWith('prisma:')).map(
      (x) => x.replace('prisma:', '') as Prisma.LogLevel
    );
    global.prisma = new PrismaClient({ log });
  }
  prisma = global.prisma;
}
