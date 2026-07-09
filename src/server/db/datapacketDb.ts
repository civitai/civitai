// App shim: datapacket read pool. See pgDb.ts for the pattern.
import { getClient, type AugmentedPool } from '~/server/db/db-helpers';
import { isProd } from '~/env/other';
import { createLogger } from '~/utils/logging';

const log = createLogger('pgDb', 'blue');

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalDatapacketDbRead: AugmentedPool | undefined;
}

export let datapacketDbRead: AugmentedPool;
if (isProd) {
  datapacketDbRead = getClient({ instance: 'datapacketRead', log });
} else {
  if (!global.globalDatapacketDbRead)
    global.globalDatapacketDbRead = getClient({ instance: 'datapacketRead', log });
  datapacketDbRead = global.globalDatapacketDbRead;
}
