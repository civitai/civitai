import { types } from 'pg';
import { isProd } from '~/env/other';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalLogicalDb: AugmentedPool | undefined;
}

// Fix Dates
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

export let logicalDb: AugmentedPool;
if (isProd) {
  logicalDb = getClient({ instance: 'logicalReplica' });
} else {
  if (!global.globalLogicalDb) global.globalLogicalDb = getClient({ instance: 'logicalReplica' });
  logicalDb = global.globalLogicalDb;
}
