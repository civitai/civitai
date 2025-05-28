import { types } from 'pg';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { getClient } from '~/server/db/db-helpers';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalNotifRead: AugmentedPool | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalNotifWrite: AugmentedPool | undefined;
}

// Fix Dates
types.setTypeParser(types.builtins.TIMESTAMP, function (stringValue) {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

export let notifDbWrite: AugmentedPool;
export let notifDbRead: AugmentedPool;
const singleClient = env.NOTIFICATION_DB_URL === env.NOTIFICATION_DB_REPLICA_URL;
if (isProd) {
  notifDbWrite = getClient({ instance: 'notification' });
  notifDbRead = singleClient ? notifDbWrite : getClient({ instance: 'notificationRead' });
} else {
  if (!global.globalNotifWrite) global.globalNotifWrite = getClient({ instance: 'notification' });
  if (!global.globalNotifRead)
    global.globalNotifRead = singleClient
      ? global.globalNotifWrite
      : getClient({ instance: 'notificationRead' });
  notifDbWrite = global.globalNotifWrite;
  notifDbRead = global.globalNotifRead;
}
