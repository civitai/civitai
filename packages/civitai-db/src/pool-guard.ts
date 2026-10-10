import type { Pool } from 'pg';

// Standalone on purpose: imports only pg's TYPES, so both db-helpers.ts (Prisma side) and kysely.ts
// (which must not pull in Prisma) can use it.

export type PoolErrorLogFn = (message: string, err: Error) => void;

// The stack, not the Error object: pg-pool attaches the whole pg Client to an idle client's error
// (`err.client`), so logging the object dumps the client's internals on every dropped connection.
const logToConsole: PoolErrorLogFn = (message, err) =>
  console.error(message, err.stack ?? err.message);

/**
 * Attach the listeners that keep a dropped database connection from crashing the process.
 *
 * `'error'` is special in Node: an `emit('error')` with no listener throws, and because node-postgres
 * emits from a socket callback, that throw is an uncaught exception. A failover drops every open
 * connection at once, along two separate paths, and each needs its own listener:
 *
 *   - An IDLE client's error is re-emitted on the POOL -> `pool.on('error')`.
 *   - A CHECKED-OUT client's error (the connection died mid-query or mid-transaction) is emitted on
 *     the CLIENT only. pg-pool (3.10) removes its own client listener while a client is checked out,
 *     so the pool-level listener does not cover this path -> a per-client listener, attached once to
 *     every client the pool creates.
 *
 * Both only log. pg-pool already discards the broken client (at once if idle, on release if checked
 * out) and pg rejects any in-flight query, so callers still see the failure at the call site. Listeners only: no pool option, parser or query path changes.
 *
 * Attach it straight after constructing the pool: the per-client listener reaches clients created
 * from then on.
 */
export function guardPool<P extends Pool>(
  pool: P,
  label = 'pg',
  logError: PoolErrorLogFn = logToConsole
): P {
  pool.on('error', (err) =>
    logError(`[db:${label}] idle client error (pool will recycle it)`, err)
  );
  pool.on('connect', (client) => {
    client.on('error', (err) => logError(`[db:${label}] client connection error`, err));
  });
  return pool;
}
