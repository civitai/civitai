import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { ITEM_HOLDER_LOCK_CLASS, lockItemHolder } from '~/server/services/item-holder-lock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * `lockItemHolder` run as written against an in-process Postgres. PGlite has one session, so no
 * second buyer can hold the lock and the `55P03` itself cannot happen here; what is read instead is
 * the `lock_timeout` each statement ran under, and what is left once the transaction ends.
 */

const db = { pg: null as unknown as PGlite };
/** `lock_timeout` as each statement of the transaction started, in order. */
let ranUnder: { sql: string; lockTimeout: string }[] = [];

const tx = () => {
  const raw = pgliteRaw(db.pg);
  return {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const [{ lock_timeout }] = (await db.pg.query<{ lock_timeout: string }>('SHOW lock_timeout'))
        .rows;
      ranUnder.push({ sql: strings.join('?'), lockTimeout: lock_timeout });
      return raw.executeRaw(strings, ...values);
    },
  } as unknown as Prisma.TransactionClient;
};
const showLockTimeout = async () =>
  (await db.pg.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout;

beforeAll(async () => {
  db.pg = new PGlite();
});
afterAll(() => db.pg.close());
afterEach(async () => {
  ranUnder = [];
  await db.pg.exec('RESET lock_timeout');
});

describe('lockItemHolder', () => {
  it('waits for the lock under a lock timeout, and leaves none once the transaction ends', async () => {
    await db.pg.exec('BEGIN');
    await lockItemHolder(tx(), 7);
    const locksHeld = await db.pg.query<{ classid: number; objid: number }>(
      `SELECT classid::int, objid::int FROM pg_locks WHERE locktype = 'advisory' AND granted`
    );
    await db.pg.exec('COMMIT');

    const lock = ranUnder.find((s) => s.sql.includes('pg_advisory_xact_lock'));
    expect(lock?.sql).toBe('SELECT pg_advisory_xact_lock(?::int, ?::int)');
    expect(lock?.lockTimeout).toBe('2s');
    expect(locksHeld.rows).toEqual([{ classid: ITEM_HOLDER_LOCK_CLASS, objid: 7 }]);
    // Transaction-local: the pooled connection goes back with the role's own setting.
    expect(await showLockTimeout()).toBe('0');
  });
});
