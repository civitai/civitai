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

import { createClients, createPool, type AugmentedPool, type DbLogFn } from '@civitai/db';
import { notifStatementTimeoutMs } from '../../../env';

/** The `LOGGING` entry that turns on the pools' query echo (the monolith's `createLogger` convention). */
export const DB_LOG_FLAG = 'notif-db';

/**
 * The pools' logger, or `undefined` unless `LOGGING` (comma-delimited) contains `notif-db`.
 *
 * Off by default because `cancellableQuery` passes the text of every statement it runs to this
 * logger, so an always-on logger prints each query once per call, including any user data formatted
 * into that text (the batched writes build their VALUES lists with pg-format). `$n` parameters
 * passed separately to a plain-string statement are not inlined. `createPool` treats a missing
 * logger as a no-op.
 */
export function log(label: string, logging = process.env.LOGGING): DbLogFn | undefined {
  const flags = (logging ?? '').split(',').map((s) => s.trim());
  if (!flags.includes(DB_LOG_FLAG)) return undefined;
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
  // createClients forces sslmode=no-verify unless ssl:false, and the docker-compose notification-db
  // has no SSL at all — without this knob a local worker cannot connect and every create is
  // swallowed as "The server does not support SSL connections".
  ssl: process.env.NOTIFICATION_DB_SSL === 'disable' ? false : undefined,
  // Set with SET on connect rather than as a startup parameter, which PgBouncer rejects. Only on the
  // notification DB, which nothing else connects to: the main-DB pools below leave the role's own timeout
  // alone, because a session SET there could outlive this client on a pooled server connection.
  perConnectionStatementTimeout: notifStatementTimeoutMs,
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

let _mainWrite: AugmentedPool | undefined;
/**
 * Primary-DB WRITE pool — used only by the push dispatcher (PushSubscription lifecycle: delete dead
 * endpoints, stamp lastSuccessAt/failureCount). Small on purpose: this is a side channel, not the
 * app's main workload, and it only exists while push is configured (see pushEnabled).
 */
export function mainDbWrite(): AugmentedPool {
  return (_mainWrite ??= createPool({
    connectionString: process.env.DATABASE_URL ?? '',
    label: 'main-write',
    applicationName: 'notif-main-write',
    max: Number(process.env.MAIN_DB_POOL_MAX ?? 5),
    log: log('main-write'),
  }));
}
