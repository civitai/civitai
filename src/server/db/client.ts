// App shim for @civitai/db Prisma clients. The package owns the env schema + factory;
// the app injects the slow-query sink (→ Axiom), owns the process singleton + Next build
// guard, and re-exports dbRead/dbWrite for existing call sites.
import { createPrismaClients, type PrismaClients } from '@civitai/db/client';
import { env } from '~/env/server';
import { replicaFallbackFor } from '~/server/db/replica-fallback';
import { logToAxiom } from '~/server/logging/client';
import { withServableProfilePictures } from '~/server/db/servable-profile-picture.extension';

export * from '@civitai/db/client';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiPrismaClients: PrismaClients | undefined;
}

const make = (): PrismaClients => {
  const base = createPrismaClients({
    onSlowQuery: ({ query, duration, target }) =>
      logToAxiom({ query, duration, target }, 'db-logs'),
    // Undefined (nothing wired) unless DATABASE_REPLICA_FALLBACK is on.
    readFallback: replicaFallbackFor('dbRead'),
  });
  return withServableProfilePictures(base, (error) => {
    logToAxiom({
      type: 'error',
      name: 'servable-profile-picture-extension',
      message: (error as Error)?.message,
    }).catch(() => undefined);
  });
};

// Process-global in EVERY environment, not just for dev HMR: the production server evaluates this
// module once per bundler module graph in the same Node process, and each evaluation would otherwise
// open its own connections.
const clients: PrismaClients = env.IS_BUILD
  ? { dbRead: undefined as never, dbWrite: undefined as never }
  : (globalThis.__civitaiPrismaClients ??= make());

export const dbRead = clients.dbRead;
export const dbWrite = clients.dbWrite;
