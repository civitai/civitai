import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export type DbClients = {
  read: Kysely<DB>;
  write: Kysely<DB>;
  // Main-app-only tiers — the spoke omits them and never calls the queries that use them.
  readLong?: Kysely<DB>;
  datapacket?: Kysely<DB>;
};

type Tier = keyof DbClients;

// The clients live on globalThis, not a module-level `let`. This package is transpiled into both apps, and a
// bundler can emit more than one copy of this module (e.g. Next's instrumentation chunk, which runs connect(),
// vs its request-route chunks, which read the clients). A `let` set by connect() in one copy would be
// invisible to the others. globalThis is the single shared cell every copy resolves through — the same reason
// pgDb.ts pins its pools to globalThis — and it also survives dev HMR and makes the clients reachable from any
// entrypoint that ran connect() at boot.
const KEY = '__civitaiDbQueriesClients__';
const store = globalThis as typeof globalThis & { [KEY]?: DbClients };

export function connect(clients: DbClients): void {
  store[KEY] = clients;
}

function resolve(tier: Tier): Kysely<DB> {
  const clients = store[KEY];
  if (!clients) throw new Error('@civitai/db-queries: connect() has not been called');
  const client = clients[tier];
  if (!client) throw new Error(`@civitai/db-queries: the "${tier}" client was not provided to connect()`);
  return client;
}

// Lazy proxies so query modules import the client vars and call them directly (`kyselyWrite.updateTable(...)`)
// while each access resolves the current client from globalThis — correct regardless of which module copy
// holds the reference. Only the first hop is proxied; the query builder it returns is the real client's.
function client(tier: Tier): Kysely<DB> {
  return new Proxy({} as Kysely<DB>, {
    get(_target, prop) {
      const c = resolve(tier) as unknown as Record<PropertyKey, unknown>;
      const value = c[prop];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(c) : value;
    },
  });
}

export const kyselyRead = client('read');
export const kyselyWrite = client('write');
export const kyselyReadLong = client('readLong');
export const kyselyDatapacket = client('datapacket');
