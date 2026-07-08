// App shim for @civitai/db Prisma clients. The package owns the env schema + factory;
// the app injects the slow-query sink (→ Axiom), owns the HMR singleton + Next build
// guard, and re-exports dbRead/dbWrite for existing call sites.
import { createPrismaClients, type PrismaClients } from '@civitai/db/client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

export * from '@civitai/db/client';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiPrismaClients: PrismaClients | undefined;
}

const make = (): PrismaClients =>
  createPrismaClients({
    onSlowQuery: ({ query, duration, target }) => logToAxiom({ query, duration, target }, 'db-logs'),
  });

const clients: PrismaClients = env.IS_BUILD
  ? { dbRead: undefined as never, dbWrite: undefined as never }
  : isProd
  ? make()
  : (global.__civitaiPrismaClients ??= make());

export const dbRead = clients.dbRead;
export const dbWrite = clients.dbWrite;
