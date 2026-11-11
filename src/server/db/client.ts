// App shim for @civitai/db Prisma clients. The package owns the env schema + factory;
// the app injects the slow-query sink (→ Axiom), owns the process singleton + Next build
// guard, and re-exports dbRead/dbWrite for existing call sites.
import { createPrismaClients, type PrismaClients } from '@civitai/db/client';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { servableProfilePictureExtension } from '~/server/db/servable-profile-picture.extension';

export * from '@civitai/db/client';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiPrismaClients: PrismaClients | undefined;
}

const make = (): PrismaClients => {
  const base = createPrismaClients({
    onSlowQuery: ({ query, duration, target }) =>
      logToAxiom({ query, duration, target }, 'db-logs'),
  });
  const extension = servableProfilePictureExtension((error) => {
    logToAxiom({
      type: 'error',
      name: 'servable-profile-picture-extension',
      message: (error as Error)?.message,
    }).catch(() => undefined);
  });
  // The extended client's type is not `PrismaClient`; every call site uses the same API.
  type Client = PrismaClients['dbWrite'];
  const extend = (client: Client) => client.$extends(extension) as unknown as Client;
  const dbWrite = extend(base.dbWrite);
  // One client when there is no replica; keep it one.
  const dbRead = base.dbRead === base.dbWrite ? dbWrite : extend(base.dbRead);
  return { dbRead, dbWrite };
};

// Process-global in EVERY environment, not just for dev HMR: the production server evaluates this
// module once per bundler module graph in the same Node process, and each evaluation would otherwise
// open its own connections.
const clients: PrismaClients = env.IS_BUILD
  ? { dbRead: undefined as never, dbWrite: undefined as never }
  : (globalThis.__civitaiPrismaClients ??= make());

export const dbRead = clients.dbRead;
export const dbWrite = clients.dbWrite;
