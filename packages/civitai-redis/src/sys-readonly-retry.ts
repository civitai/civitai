/**
 * Bounded, backed-off retry of sysRedis writes rejected with `READONLY`.
 *
 * During a primary failover there is a short window in which the old primary has already been
 * demoted to a replica but the client still routes writes to it. RedisSentinel re-resolves the
 * master and retries on `READONLY` itself, but back to back with no delay, so it can use up all of
 * its attempts before the Sentinels report the new primary and the caller gets the error. This
 * spaces a few more attempts out over under a second; each one runs through the client again, so
 * on another `READONLY` RedisSentinel re-resolves the master before resending.
 *
 * Retrying is safe for writes: a replica rejects a write with `READONLY` before executing it, so
 * the rejected command was not applied. That holds for one command (and for a MULTI, which aborts
 * as a whole) but not for a pipeline, whose earlier writes may have run on the primary before it
 * was demoted, so this wrapper never retries a pipeline: it runs under `withoutSysReadonlyRetry`.
 */

/** Delay before each retry (ms); its length is the number of retries. */
export const SYS_READONLY_RETRY_BACKOFF_MS: readonly number[] = [50, 100, 200, 400];

export type SysReadonlyRetryResult = 'recovered' | 'exhausted';

export interface SysReadonlyRetryOptions {
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onResult?: (result: SysReadonlyRetryResult, retries: number) => void;
}

/** A Redis `READONLY` error reply (the server rejected a write sent to a replica). */
export function isReadonlyError(err: unknown): boolean {
  return err instanceof Error && /^READONLY\b/.test(err.message);
}

const defaultSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

export async function withSysReadonlyRetry<T>(
  exec: () => Promise<T>,
  options: SysReadonlyRetryOptions = {}
): Promise<T> {
  const backoff = options.backoffMs ?? SYS_READONLY_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  const report = (result: SysReadonlyRetryResult, retries: number) => {
    try {
      options.onResult?.(result, retries);
    } catch {
      // A broken hook must not change what the caller gets.
    }
  };

  for (let retries = 0; ; retries++) {
    try {
      const value = await exec();
      if (retries > 0) report('recovered', retries);
      return value;
    } catch (err) {
      if (!isReadonlyError(err)) throw err;
      if (retries >= backoff.length) {
        if (retries > 0) report('exhausted', retries);
        throw err;
      }
      await sleep(backoff[retries]);
    }
  }
}

let noRetryDepth = 0;

/**
 * Run `fn` with READONLY retry disabled for every command it STARTS synchronously. RedisSentinel's
 * `_executePipeline` calls `_execute` before its first await, so wrapping it marks the pipeline.
 *
 * A synchronous depth counter rather than AsyncLocalStorage: this package is reachable from the
 * browser bundle, which has no `async_hooks`. The ordering it relies on is pinned against the real
 * @redis/client prototype in __tests__/sys-readonly-retry.test.ts ("real RedisSentinel").
 */
export function withoutSysReadonlyRetry<T>(fn: () => T): T {
  noRetryDepth++;
  try {
    return fn();
  } finally {
    noRetryDepth--;
  }
}

export function isSysReadonlyRetryAllowed(): boolean {
  return noRetryDepth === 0;
}
