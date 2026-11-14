// Prisma read/write client factory. The generated client + types come from the
// @civitai/db-schema contract package, never @prisma/client directly.
import type { Prisma } from '@civitai/db-schema';
import { PrismaClient } from '@civitai/db-schema';
import { loadDbEnv, type DbConfig } from './env';
import { connectionRetryExtension, type ConnectionRetryEvent } from './connection-retry';

export type PrismaClients = { dbRead: PrismaClient; dbWrite: PrismaClient };

export type CreatePrismaClientsOptions = Partial<DbConfig> & {
  /** Structured slow-query telemetry (the old logToAxiom call). Injected by the app. */
  onSlowQuery?: (e: { query: string; duration: number; target: 'read' | 'write' }) => void;
  /** Called after a read is retried because its pooled connection had been closed. Must not throw. */
  onConnectionRetry?: (e: ConnectionRetryEvent & { target: 'read' | 'write' }) => void;
};

/**
 * Build the Prisma read/write clients. Connection config defaults come from the
 * package env schema (./env, overridable via options); app behavior (logger, slow-query
 * sink) is injected. HMR/global caching and the Next build guard live in the app shim
 * that calls this. See the `~/server/db/client` shim.
 */
export function createPrismaClients(options: CreatePrismaClientsOptions = {}): PrismaClients {
  const { onSlowQuery, onConnectionRetry, ...envOverrides } = options;
  const config = { ...loadDbEnv(), ...envOverrides };

  const singleClient = config.replicaUrl === config.databaseUrl;

  const logFor = (target: 'write' | 'read') =>
    async function logQuery(e: { query: string; params: string; duration: number }) {
      if (e.duration < 2000) return;
      let query = e.query;
      const params = JSON.parse(e.params);
      // Replace $X variables with params in query so it's possible to copy/paste and optimize
      for (let i = 0; i < params.length; i++) {
        // Negative lookahead for no more numbers, ie. replace $1 in '$1' but not '$11'
        const re = new RegExp('\\$' + ((i as number) + 1) + '(?!\\d)', 'g');
        // If string, will quote - if bool or numeric, will not - does the job here
        if (typeof params[i] === 'string') params[i] = "'" + params[i].replace(/'/g, "\\'") + "'";
        query = query.replace(re, params[i]);
      }

      if (!config.isProd) console.log(query);
      else onSlowQuery?.({ query, duration: e.duration, target });
    };

  const createPrismaClient = ({ readonly }: { readonly: boolean }): PrismaClient => {
    const logDef: Prisma.LogDefinition[] = config.logging
      .filter((x) => x.startsWith('prisma:'))
      .map((x) => ({ emit: 'stdout', level: x.replace('prisma:', '') as Prisma.LogLevel }));
    if (config.logging.some((x) => x.includes('prisma-slow'))) {
      const existingItemIndex = logDef.findIndex((x) => x.level === 'query');
      if (existingItemIndex >= 0) logDef.splice(existingItemIndex, 1);
      logDef.push({ emit: 'event', level: 'query' });
    }
    const dbUrl = readonly ? config.replicaUrl : config.databaseUrl;
    const clientOptions = {
      log: logDef,
      datasources: { db: { url: dbUrl } },
      // A legacy billing pointer no client may see. Runtime only: the types still list the field,
      // because typing the clients with this omit runs `tsc` out of memory. Read it with an explicit
      // `omit: { subscriptionId: false }` or `select`.
      omit: { user: { subscriptionId: true } },
    } as Prisma.PrismaClientOptions;
    const prisma = new PrismaClient(clientOptions);

    // use with prisma-slow,prisma-showparams
    if (config.logging.some((x) => x === 'prisma-showparams')) {
      // @ts-ignore
      prisma.$on('query', async (e: { query: string; params: string; duration: number }) => {
        let query = e.query;
        const params = JSON.parse(e.params);
        for (let i = 0; i < params.length; i++) {
          const re = new RegExp('\\$' + ((i as number) + 1) + '(?!\\d)', 'g');
          if (typeof params[i] === 'string') params[i] = "'" + params[i].replace(/'/g, "\\'") + "'";
          query = query.replace(re, params[i]);
        }
        console.log(query);
      });
    }
    return prisma;
  };

  const dbWrite = createPrismaClient({ readonly: false });
  const dbRead = singleClient ? dbWrite : createPrismaClient({ readonly: true });

  if (config.logging.includes('prisma-slow-write'))
    // @ts-ignore - necessary to get the query event
    dbWrite.$on('query', logFor('write'));
  if (config.logging.includes('prisma-slow-read'))
    // @ts-ignore - necessary to get the query event
    dbRead.$on('query', logFor('read'));

  // After the `$on` calls: an extended client has no `$on`. Every client gets the read retry (see
  // ./connection-retry); writes on the write client pass through it untouched. The extended client's
  // type is not the base client's, but every call site uses the same API.
  const withRetry = (client: PrismaClient, target: 'read' | 'write') =>
    client.$extends(
      connectionRetryExtension({
        onRetry: onConnectionRetry && ((e) => onConnectionRetry({ ...e, target })),
      })
    ) as unknown as PrismaClient;
  const retryingWrite = withRetry(dbWrite, 'write');
  const retryingRead = singleClient ? retryingWrite : withRetry(dbRead, 'read');

  return { dbRead: retryingRead, dbWrite: retryingWrite };
}
