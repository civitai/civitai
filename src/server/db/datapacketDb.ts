// App shim: datapacket read pool. See pgDb.ts for the pattern.
import { getClient, type AugmentedPool } from '~/server/db/db-helpers';
import { createLogger } from '~/utils/logging';

const log = createLogger('pgDb', 'blue');

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalDatapacketDbRead: AugmentedPool | undefined;
}

export const datapacketDbRead: AugmentedPool = (globalThis.globalDatapacketDbRead ??= getClient({
  instance: 'datapacketRead',
  log,
}));
