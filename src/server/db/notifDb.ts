// App shim: notification pg pools. See pgDb.ts for the pattern.
import { getClient, type AugmentedPool } from '@civitai/db/db-helpers';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';

const log = createLogger('pgDb', 'blue');

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalNotifRead: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalNotifWrite: AugmentedPool | undefined;
}

export let notifDbWrite: AugmentedPool;
export let notifDbRead: AugmentedPool;
const singleClient = env.NOTIFICATION_DB_URL === env.NOTIFICATION_DB_REPLICA_URL;
if (isProd) {
  notifDbWrite = getClient({ instance: 'notification', log });
  notifDbRead = singleClient ? notifDbWrite : getClient({ instance: 'notificationRead', log });
} else {
  if (!global.globalNotifWrite)
    global.globalNotifWrite = getClient({ instance: 'notification', log });
  if (!global.globalNotifRead)
    global.globalNotifRead = singleClient
      ? global.globalNotifWrite
      : getClient({ instance: 'notificationRead', log });
  notifDbWrite = global.globalNotifWrite;
  notifDbRead = global.globalNotifRead;
}
