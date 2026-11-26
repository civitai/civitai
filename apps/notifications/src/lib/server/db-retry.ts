// Bounded retry of single DB statements across a database primary switchover. For a short window the
// pooler refuses or drops connections, and without a retry every request in that window fails.

import type { QueryResultRow } from 'pg';
import { dbUnavailableCause, isTransientDbConnectionError, type AugmentedPool } from '@civitai/db';
import { logToAxiom } from './clients/axiom';

/** Base delay before each retry (ms); its length is the number of retries. Jittered, see withDbRetry. */
export const DB_RETRY_BACKOFF_MS: readonly number[] = [100, 250, 500];

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `failed`: a retry ran, then the call failed with an error that is not retried. */
export type DbRetryResult = 'recovered' | 'exhausted' | 'failed';

export interface DbRetryOptions {
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1); each delay is its base scaled by 0.5 + random() (±50%), so callers do not retry in step. */
  random?: () => number;
  /** Called once when a retried call settles: recovered, or exhausted/failed with `err` rethrown. */
  onResult?: (result: DbRetryResult, retries: number, err?: unknown) => void;
}

/**
 * Run `fn`, retrying it after each jittered `backoffMs` delay while it fails with a transient connection
 * error. Any other error, or the last connection error, is thrown as is.
 *
 * A connection can drop after the server committed a write but before the reply arrived, so `fn` must
 * be safe to run twice: a read, or a write that is idempotent.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, opts: DbRetryOptions = {}): Promise<T> {
  const backoff = opts.backoffMs ?? DB_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const report = (result: DbRetryResult, retries: number, err?: unknown) => {
    try {
      opts.onResult?.(result, retries, err);
    } catch {
      // A broken hook must not change what the caller gets.
    }
  };
  // A local loop on purpose: the app cannot import ~/utils (withRetries has no error predicate,
  // backoffDelay's jitter is additive), and this one needs a classifier and multiplicative jitter.
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await fn();
      if (attempt > 0) report('recovered', attempt);
      return value;
    } catch (err) {
      if (!isTransientDbConnectionError(err)) {
        if (attempt > 0) report('failed', attempt, err);
        throw err;
      }
      if (attempt >= backoff.length) {
        if (attempt > 0) report('exhausted', attempt, err);
        throw err;
      }
      await sleep(Math.round(backoff[attempt] * (0.5 + random())));
    }
  }
}

// { name, code } only: an error message can carry a host. dbUnavailableCause does not know the
// pooler's 28P01 or a non-connection error, so those fall back to the error's own name and code.
function retryCause(err: unknown): { name: string; code: string } | undefined {
  const known = dbUnavailableCause(err);
  if (known || !err || typeof err !== 'object') return known;
  const e = err as { name?: unknown; code?: unknown };
  return {
    name: typeof e.name === 'string' ? e.name : 'Error',
    code: typeof e.code === 'string' ? e.code : '',
  };
}

function logDbRetry(result: DbRetryResult, retries: number, err?: unknown) {
  void Promise.resolve(
    logToAxiom({
      type: result === 'recovered' ? 'info' : 'warning',
      name: 'notification.dbRetry',
      message: `DB statement ${result} after ${retries} retries`,
      outcome: result,
      retries,
      ...(err ? { cause: retryCause(err) } : {}),
    })
  ).catch(() => undefined);
}

/**
 * `cancellableQuery` + `result()` under `withDbRetry`, so a connection lost during the statement is
 * retried as well as one lost at checkout. The same idempotency requirement applies.
 */
export function queryWithRetry<R extends QueryResultRow>(
  db: Pick<AugmentedPool, 'cancellableQuery'>,
  sql: string,
  params: unknown[]
): Promise<R[]> {
  return withDbRetry(async () => (await db.cancellableQuery<R>(sql, params)).result(), {
    onResult: logDbRetry,
  });
}
