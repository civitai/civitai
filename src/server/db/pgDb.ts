// App shim: primary pg pools. Calls the app-side getClient factory (which owns the monolith's DB
// topology + env), injects the debug logger, and owns the process globals + Next build guard. Re-exports
// the pool instances for existing call sites.
import { getClient, type AugmentedPool } from '~/server/db/db-helpers';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';

const log = createLogger('pgDb', 'blue');

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgRead: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgReadLong: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgWrite: AugmentedPool | undefined;
}

export let pgDbWrite: AugmentedPool;
export let pgDbRead: AugmentedPool;
export let pgDbReadLong: AugmentedPool;

// Process-global in EVERY environment, not just for dev HMR: the production server evaluates this
// module once per bundler module graph in the same Node process, and each evaluation would otherwise
// open its own connections.
if (!env.IS_BUILD) {
  const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
  const write = (globalThis.globalPgWrite ??= getClient({ log }));
  pgDbWrite = write;
  pgDbRead = globalThis.globalPgRead ??= singleClient
    ? write
    : getClient({ instance: 'primaryRead', log });
  pgDbReadLong = globalThis.globalPgReadLong ??= singleClient
    ? write
    : getClient({ instance: 'primaryReadLong', log });
}
