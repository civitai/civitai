import { types } from 'pg';
import { isProd } from '~/env/other';
import { env } from '~/env/server.mjs';
import { AugmentedPool, getClient } from '~/server/db/db-helpers';

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
  notifDbWrite = getClient({ readonly: false, isNotification: true });
  notifDbRead = singleClient ? notifDbWrite : getClient({ readonly: true, isNotification: true });
} else {
  if (!global.globalNotifWrite)
    global.globalNotifWrite = getClient({ readonly: false, isNotification: true });
  if (!global.globalNotifRead)
    global.globalNotifRead = singleClient
      ? global.globalNotifWrite
      : getClient({ readonly: true, isNotification: true });
  notifDbWrite = global.globalNotifWrite;
  notifDbRead = global.globalNotifRead;
}
