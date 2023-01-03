// src/server/db/client.ts
import { PrismaClient } from '@prisma/client';
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
    global.prisma = new PrismaClient({ log: ['query', 'error', 'warn'] });
  }
  prisma = global.prisma;
}
