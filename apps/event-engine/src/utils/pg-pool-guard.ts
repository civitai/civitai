import { Pool, type PoolConfig } from 'pg';

export type PoolErrorLogFn = (message: string, err: Error) => void;

/** The one place this app builds a pg Pool (the ESLint allowlist names this file): always guarded. */
export function createGuardedPgPool(
  config: PoolConfig,
  label: string,
  logError: PoolErrorLogFn
): Pool {
  return guardPgPool(new Pool(config), label, logError);
}

/**
 * Keep a dropped database connection from crashing the process.
 *
 * Same pattern as `guardPool` in packages/civitai-db/src/pool-guard.ts, copied rather than imported
 * because this app depends on no @civitai/* workspace package: it builds with plain `tsc` to CommonJS
 * and runs the output with `node`, while @civitai/db ships TypeScript source (see the Dockerfile).
 * Keep the two in step.
 *
 * `'error'` with no listener throws, and pg emits it from a socket callback, so the throw is an
 * uncaught exception. Once the consumer is running that reaches the process-level handler in
 * src/index.ts, which shuts the whole consumer down (before then, nothing catches it and the process
 * crashes) — so without these listeners a single dropped connection takes the app down.
 *
 *   - An IDLE client's error is re-emitted on the POOL -> `pool.on('error')`.
 *   - A CHECKED-OUT client's error (dropped mid-query) is emitted on the CLIENT only: pg-pool removes
 *     its own client listener while a client is checked out -> a listener on every client.
 *
 * Both only log. pg-pool discards the broken client (at once if idle, on release if checked out) and
 * pg rejects any in-flight query at its call site.
 */
export function guardPgPool<P extends Pool>(pool: P, label: string, logError: PoolErrorLogFn): P {
  pool.on('error', (err) =>
    logError(`[pg:${label}] idle client error (pool will recycle it)`, err)
  );
  pool.on('connect', (client) => {
    client.on('error', (err) => logError(`[pg:${label}] client connection error`, err));
  });
  return pool;
}
