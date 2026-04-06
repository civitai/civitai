import { types } from 'pg';
import { isProd } from '~/env/other';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalDatapacketDbRead: AugmentedPool | undefined;
}

// Fix Dates
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

export let datapacketDbRead: AugmentedPool;
if (isProd) {
  datapacketDbRead = getClient({ instance: 'datapacketRead' });
} else {
  if (!global.globalDatapacketDbRead)
    global.globalDatapacketDbRead = getClient({ instance: 'datapacketRead' });
  datapacketDbRead = global.globalDatapacketDbRead;
}
