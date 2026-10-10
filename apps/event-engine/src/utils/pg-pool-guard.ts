import { Pool, type PoolConfig } from 'pg';

export type PoolErrorLogFn = (message: string, err: Error) => void;

/** The only place this app may build a pg Pool (ESLint-allowlisted). */
export function createGuardedPgPool(
  config: PoolConfig,
  label: string,
  logError: PoolErrorLogFn
): Pool {
  return guardPgPool(new Pool(config), label, logError);
}

/**
 * Copy of `guardPool` in packages/civitai-db/src/pool-guard.ts (see it for why both listeners are
 * needed). Copied because this app builds with plain `tsc` to CommonJS and depends on no @civitai/*
 * package, while @civitai/db ships TypeScript source. Keep the two in step. Unguarded, a drop reaches
 * the uncaughtException handler in src/index.ts, which shuts the consumer down (or, before startup,
 * crashes it).
 */
export function guardPgPool<P extends Pool>(pool: P, label: string, logError: PoolErrorLogFn): P {
  // One drop can reach both listeners (an idle client's error is re-emitted on the pool), so log
  // each error once.
  const logged = new WeakSet<Error>();
  const logOnce = (err: Error) => {
    if (logged.has(err)) return;
    logged.add(err);
    logError(`[pg:${label}] connection error (the pool discards the client)`, err);
  };
  pool.on('error', logOnce);
  pool.on('connect', (client) => client.on('error', logOnce));
  return pool;
}
