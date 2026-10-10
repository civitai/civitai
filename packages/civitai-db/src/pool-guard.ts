import type { Pool } from 'pg';

// Standalone on purpose: imports only pg's TYPES, so both db-helpers.ts (Prisma side) and kysely.ts
// (which must not pull in Prisma) can use it.

export type PoolErrorLogFn = (message: string, err: Error) => void;

// The stack, not the Error object: pg-pool attaches the whole pg Client to an idle client's error
// (`err.client`), so logging the object dumps the client's internals on every dropped connection.
const logToConsole: PoolErrorLogFn = (message, err) =>
  console.error(message, err.stack ?? err.message);

/**
 * Keep a dropped database connection from crashing the process. `'error'` with no listener throws, and
 * pg emits from a socket callback, so the throw is uncaught. A failover drops every connection at
 * once, along two paths that each need a listener:
 *   - IDLE client: the error is re-emitted on the POOL -> `pool.on('error')`.
 *   - CHECKED-OUT client (dropped mid-query): emitted on the CLIENT only, because pg-pool (3.10) removes
 *     its own client listener during checkout -> a listener on every client, via `pool.on('connect')`.
 * Both only log. pg-pool discards the broken client (at once if idle, on release if checked out) and pg
 * rejects the in-flight query at its call site.
 *
 * Attach straight after constructing the pool: the per-client listener only reaches clients created
 * after it.
 */
export function guardPool<P extends Pool>(
  pool: P,
  label = 'pg',
  logError: PoolErrorLogFn = logToConsole
): P {
  // One drop can reach both listeners (an idle client's error is re-emitted on the pool), so log
  // each error once.
  const logged = new WeakSet<Error>();
  const logOnce = (err: Error) => {
    if (logged.has(err)) return;
    logged.add(err);
    logError(`[db:${label}] connection error (the pool discards the client)`, err);
  };
  pool.on('error', logOnce);
  pool.on('connect', (client) => client.on('error', logOnce));
  return pool;
}
