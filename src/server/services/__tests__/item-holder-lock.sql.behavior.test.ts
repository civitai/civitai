import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { ITEM_HOLDER_LOCK_CLASS, lockItemHolder } from '~/server/services/item-holder-lock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * PGlite has one session, so a second buyer cannot hold the lock and `55P03` cannot happen here; this
 * reads the `lock_timeout` each statement ran under, and what is left after the transaction ends.
 */

const db = { pg: null as unknown as PGlite };
let ranUnder: { sql: string; lockTimeout: string }[] = [];

const showLockTimeout = async () =>
  (await db.pg.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0].lock_timeout;
const tx = () => {
  const raw = pgliteRaw(db.pg);
  return {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      ranUnder.push({ sql: strings.join('?'), lockTimeout: await showLockTimeout() });
      return raw.executeRaw(strings, ...values);
    },
  } as unknown as Prisma.TransactionClient;
};

beforeAll(async () => {
  db.pg = new PGlite();
});
afterAll(() => db.pg.close());
afterEach(async () => {
  ranUnder = [];
  await db.pg.exec('RESET lock_timeout');
});

describe('lockItemHolder', () => {
  it('waits for the lock, and every later statement, under a lock timeout that ends with the transaction', async () => {
    await db.pg.exec('BEGIN');
    const client = tx();
    await lockItemHolder(client, 7);
    await client.$executeRaw`SELECT 1`;
    const locksHeld = await db.pg.query<{ classid: number; objid: number }>(
      `SELECT classid::int, objid::int FROM pg_locks WHERE locktype = 'advisory' AND granted`
    );
    await db.pg.exec('COMMIT');

    const lock = ranUnder.find((s) => s.sql.includes('pg_advisory_xact_lock'));
    expect(lock?.sql).toBe('SELECT pg_advisory_xact_lock(?::int, ?::int)');
    expect(lock?.lockTimeout).toBe('2s');
    expect(ranUnder.at(-1)).toEqual({ sql: 'SELECT 1', lockTimeout: '2s' });
    expect(locksHeld.rows).toEqual([{ classid: ITEM_HOLDER_LOCK_CLASS, objid: 7 }]);
    expect(await showLockTimeout()).toBe('0');
  });
});
