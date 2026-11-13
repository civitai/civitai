import type pg from 'pg';

/** The longest a write waits for another writer of the same conversation. */
const LOCK_WAIT_MS = 120_000;

/** Runs `fn` with the conversation's head to itself, across every replica. */
export interface ConversationLock {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * A Postgres session advisory lock in the runner's own database, per conversation. Held on its own
 * connection for the length of one read-change-write; a process that dies drops its connection and
 * with it the lock.
 */
export class AdvisoryLock implements ConversationLock {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken: Error | undefined;
    try {
      // Bounded: a writer that never gets the lock fails loudly instead of holding its connection.
      await client.query(`set lock_timeout = '${LOCK_WAIT_MS}ms'`);
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [key]);
      try {
        return await fn();
      } finally {
        await client
          .query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch((error: Error) => (broken = error));
      }
    } finally {
      // A connection whose unlock failed may still hold the lock: closing it lets the lock go.
      client.release(broken);
    }
  }
}
