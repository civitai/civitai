// Bounded retry of single DB statements across a database primary switchover. For a short window the
// pooler refuses or drops connections, and without a retry every request in that window fails.

import type { QueryResultRow } from 'pg';
import { dbUnavailableCause, isDbConnectionError, type AugmentedPool } from '@civitai/db';
import { logToAxiom } from './clients/axiom';

/** Base delay before each retry (ms); its length is the number of retries. Jittered, see withDbRetry. */
export const DB_RETRY_BACKOFF_MS: readonly number[] = [100, 250, 500];

// During a switchover the pooler can briefly fail its own login to the new primary and pass that on as
// an auth failure, which isDbConnectionError (a connection-loss classifier) does not count.
const PG_INVALID_PASSWORD = '28P01';

// pg's own connect timeout. Each attempt can wait the pool's full connectionTimeoutMillis before this,
// so retrying it would hold the caller far past its own deadline.
const PG_CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout';

function hasConnectTimeoutInChain(err: unknown): boolean {
  let cur = err as { message?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if (typeof cur.message === 'string' && cur.message.startsWith(PG_CONNECT_TIMEOUT_MESSAGE))
      return true;
    cur = cur.cause as typeof cur;
  }
  return false;
}

/**
 * What isDbConnectionError counts (from @civitai/db), plus the pooler's auth failure above, minus pg's
 * connect timeout. That covers: a pg server error of the connection-exception class (08xxx) or a
 * shutdown / cannot-connect-now (57P01-57P03, 53300); pg's "Connection terminated unexpectedly",
 * whether the connection dropped while connecting or mid-statement; and a raw socket error
 * (ECONNREFUSED, ECONNRESET, …) only when createPool marked it as raised while connecting — an
 * ECONNRESET during a statement is not marked and is not retried. Never an error raised by a
 * statement's own SQL or data (a constraint, a cast, a syntax error). A pooled-connection wait that
 * timed out is not included either: retrying it only queues behind a saturated pool again.
 */
export function isTransientDbConnectionError(err: unknown): boolean {
  if (hasConnectTimeoutInChain(err)) return false;
  if (isDbConnectionError(err)) return true;
  const e = err as { code?: unknown; severity?: unknown } | null;
  return typeof e?.severity === 'string' && e.code === PG_INVALID_PASSWORD;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type DbRetryResult = 'recovered' | 'exhausted';

export interface DbRetryOptions {
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1); each delay is its base scaled by 0.5 + random() (±50%), so callers do not retry in step. */
  random?: () => number;
  /** Called once when a retried call settles: recovered, or exhausted with `err` rethrown. */
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
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await fn();
      if (attempt > 0) report('recovered', attempt);
      return value;
    } catch (err) {
      if (!isTransientDbConnectionError(err)) throw err;
      if (attempt >= backoff.length) {
        if (attempt > 0) report('exhausted', attempt, err);
        throw err;
      }
      await sleep(Math.round(backoff[attempt] * (0.5 + random())));
    }
  }
}

function logDbRetry(result: DbRetryResult, retries: number, err?: unknown) {
  // dbUnavailableCause is { name, code } only: an error message can carry a host.
  void Promise.resolve(
    logToAxiom({
      type: result === 'recovered' ? 'info' : 'warning',
      name: 'notification.dbRetry',
      message: `DB statement ${result} after ${retries} retries`,
      outcome: result,
      retries,
      ...(err ? { cause: dbUnavailableCause(err) } : {}),
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
