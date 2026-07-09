// App shim: primary pg pools. Calls the app-side getClient factory (which owns the monolith's DB
// topology + env), injects the debug logger, and owns the HMR globals + Next build guard. Re-exports
// the pool instances for existing call sites.
import { getClient, type AugmentedPool } from '~/server/db/db-helpers';
import { isProd } from '~/env/other';
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

if (!env.IS_BUILD) {
  const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
  if (isProd) {
    pgDbWrite = getClient({ log });
    pgDbRead = singleClient ? pgDbWrite : getClient({ instance: 'primaryRead', log });
    pgDbReadLong = singleClient ? pgDbWrite : getClient({ instance: 'primaryReadLong', log });
  } else {
    if (!global.globalPgWrite) global.globalPgWrite = getClient({ log });
    if (!global.globalPgRead)
      global.globalPgRead = singleClient
        ? global.globalPgWrite
        : getClient({ instance: 'primaryRead', log });
    if (!global.globalPgReadLong)
      global.globalPgReadLong = singleClient
        ? global.globalPgWrite
        : getClient({ instance: 'primaryReadLong', log });
    pgDbWrite = global.globalPgWrite;
    pgDbRead = global.globalPgRead;
    pgDbReadLong = global.globalPgReadLong;
  }
}
