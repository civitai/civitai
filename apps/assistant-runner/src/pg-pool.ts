import pg from 'pg';

/**
 * The runner's one way to build a node-postgres pool, with the listeners `guardPool` in
 * `packages/civitai-db/src/pool-guard.ts` attaches (that package is not usable from this standalone
 * app): an `'error'` with no listener throws from a socket callback and crashes the process, and a
 * failover drops every connection at once. An idle client's error reaches the pool; a checked-out
 * client's reaches only the client. Both are logged once; pg-pool discards the broken client and pg
 * rejects the query in flight at its call site.
 */
export function createPool(
  options: pg.PoolConfig,
  label: string,
  logError: (message: string, err: Error) => void = (message, err) =>
    console.error(message, err.stack ?? err.message)
): pg.Pool {
  const pool = new pg.Pool(options);
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
