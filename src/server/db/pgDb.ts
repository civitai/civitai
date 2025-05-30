import { types } from 'pg';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgRead: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgReadLong: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgWrite: AugmentedPool | undefined;
}

// Fix Dates
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

export let pgDbWrite: AugmentedPool;
export let pgDbRead: AugmentedPool;
export let pgDbReadLong: AugmentedPool;
const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
if (isProd) {
  pgDbWrite = getClient();
  pgDbRead = singleClient ? pgDbWrite : getClient({ instance: 'primaryRead' });
  pgDbReadLong = singleClient ? pgDbWrite : getClient({ instance: 'primaryReadLong' });
} else {
  if (!global.globalPgWrite) global.globalPgWrite = getClient();
  if (!global.globalPgRead)
    global.globalPgRead = singleClient
      ? global.globalPgWrite
      : getClient({ instance: 'primaryRead' });
  if (!global.globalPgReadLong)
    global.globalPgReadLong = singleClient
      ? global.globalPgWrite
      : getClient({ instance: 'primaryReadLong' });
  pgDbWrite = global.globalPgWrite;
  pgDbRead = global.globalPgRead;
  pgDbReadLong = global.globalPgReadLong;
}
