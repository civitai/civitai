// Bounded retry of single DB statements across a database primary switchover. For a short window the
// pooler refuses or drops connections, and without a retry every request in that window fails.

import type { QueryResultRow } from 'pg';
import { isDbConnectionError, type AugmentedPool } from '@civitai/db';

/** Delay before each retry (ms); its length is the number of retries. */
export const DB_RETRY_BACKOFF_MS: readonly number[] = [100, 250, 500];

// During a switchover the pooler can briefly fail its own login to the new primary and pass that on as
// an auth failure, which isDbConnectionError (a connection-loss classifier) does not count.
const PG_INVALID_PASSWORD = '28P01';

/**
 * A failure to get or keep a connection, never one raised by a statement's own SQL or data (a
 * constraint, a cast, a syntax error). A pooled-connection wait that timed out is not included:
 * retrying it only queues behind a saturated pool again.
 */
export function isTransientDbConnectionError(err: unknown): boolean {
  if (isDbConnectionError(err)) return true;
  const e = err as { code?: unknown; severity?: unknown } | null;
  return typeof e?.severity === 'string' && e.code === PG_INVALID_PASSWORD;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying it after each `backoffMs` delay while it fails with a transient connection error.
 * Any other error, or the last connection error, is thrown as is.
 *
 * A connection can drop after the server committed a write but before the reply arrived, so `fn` must
 * be safe to run twice: a read, or a write that is idempotent.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts: { backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const backoff = opts.backoffMs ?? DB_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= backoff.length || !isTransientDbConnectionError(err)) throw err;
      await sleep(backoff[attempt]);
    }
  }
}

/** `cancellableQuery` + `result()` under `withDbRetry`: the same idempotency requirement applies. */
export function queryWithRetry<R extends QueryResultRow>(
  db: Pick<AugmentedPool, 'cancellableQuery'>,
  sql: string,
  params: unknown[]
): Promise<R[]> {
  return withDbRetry(async () => (await db.cancellableQuery<R>(sql, params)).result());
}
