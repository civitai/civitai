import { types } from 'pg';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { AugmentedPool, getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgRead: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalPgWrite: AugmentedPool | undefined;
}

// Fix Dates
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

export let pgDbWrite: AugmentedPool;
export let pgDbRead: AugmentedPool;
const singleClient = env.DATABASE_REPLICA_URL === env.DATABASE_URL;
if (isProd) {
  pgDbWrite = getClient();
  pgDbRead = singleClient ? pgDbWrite : getClient({ readonly: true });
} else {
  if (!global.globalPgWrite) global.globalPgWrite = getClient();
  if (!global.globalPgRead)
    global.globalPgRead = singleClient ? global.globalPgWrite : getClient({ readonly: true });
  pgDbWrite = global.globalPgWrite;
  pgDbRead = global.globalPgRead;
}
