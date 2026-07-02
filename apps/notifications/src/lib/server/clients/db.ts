// The app's pg pools, built via the shared @civitai/db builders from explicit connection strings — the
// SAME augmented-pool core (cancellableQuery, checked-out-client handling, acquire metrics) the monolith
// uses, so the hand-forked src/db.ts from the external notification-server is gone (the §2a motivation).
//   - createClients(): the notif WRITE + READ pair — pass both URLs (single pool when the replica URL is
//     omitted or equal), no knowledge of the monolith's env/instance map needed.
//   - createPool(): the single main-DB read pool for the userNotificationSettings opt-out filter — free
//     now that we're in-repo (§2c); the external server could never reach the main DB.
//
// Both accessors are lazy + memoized, so importing this module never connects (build/typecheck/health-
// only tests don't touch the DB).

import { createClients, createPool, type AugmentedPool } from '@civitai/db';

function log(label: string) {
  return (message: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[notifications:db:${label}] ${message}`, ...args);
}

export const { write: notifDbWrite, read: notifDbRead } = createClients({
  writeUrl: process.env.NOTIFICATION_DB_URL ?? '',
  readUrl: process.env.NOTIFICATION_DB_REPLICA_URL,
  label: 'notif',
  applicationName: 'notif-pg',
  max: Number(process.env.NOTIFICATION_POOL_MAX ?? process.env.DATABASE_POOL_MAX ?? 20),
  log: log('notif'),
});

let _mainRead: AugmentedPool | undefined;
/** Primary-DB read pool — used only for the userNotificationSettings opt-out filter. */
export function mainDbRead(): AugmentedPool {
  return (_mainRead ??= createPool({
    connectionString: process.env.DATABASE_REPLICA_URL ?? '',
    label: 'main-read',
    applicationName: 'notif-main-read',
    log: log('main-read'),
  }));
}
