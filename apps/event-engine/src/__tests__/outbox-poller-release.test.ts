// A connection checked out by the outbox poller must never go back to the pool in an unknown state. After
// an error, a batch connection can still hold an open transaction and its FOR UPDATE row locks (the
// ROLLBACK itself can fail or time out, and a query abandoned by pg's query_timeout is still running on the
// server), and the leader connection can still hold the advisory lock. So every error path releases with
// the error, which makes the pool destroy the client instead of handing it to the next caller.
//
// Pool and clients are fakes; what is under test is what the poller passes to release().
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OutboxPoller } from '@/services/outbox-poller';

class FakeClient extends EventEmitter {
  queries: string[] = [];
  releasedWith: unknown[] = [];
  constructor(private respond: (text: string) => unknown) {
    super();
  }
  async query(text: string) {
    this.queries.push(text);
    return this.respond(text);
  }
  release(err?: unknown) {
    this.releasedWith.push(err);
  }
}

const timeout = () => new Error('Query read timeout');

function leaderWith(respond: (text: string) => unknown) {
  return new FakeClient(respond);
}
const winsLock = (text: string) =>
  text.includes('pg_try_advisory_lock') ? { rows: [{ acquired: true }] } : { rows: [] };

function poolOf(leader: FakeClient, batch?: FakeClient) {
  let checkouts = 0;
  return {
    connect: vi.fn(async () => (++checkouts === 1 ? leader : batch)),
    query: vi.fn(async () => ({ rows: [{ n: 0 }] })),
  } as unknown as Pool;
}

const poller = (pool: Pool) => new OutboxPoller(pool, async () => undefined, 60_000, 0, 10);

describe('OutboxPoller releases a connection with the error on every error path', () => {
  test('a batch whose claim and ROLLBACK both time out is destroyed, not returned', async () => {
    const batch = new FakeClient((text) => {
      if (text === 'BEGIN') return { rows: [] };
      throw timeout(); // the claim, then the ROLLBACK
    });
    const leader = leaderWith(winsLock);
    await expect(poller(poolOf(leader, batch)).sweep()).rejects.toThrow('Query read timeout');

    expect(batch.queries).toContain('ROLLBACK');
    expect(batch.releasedWith).toHaveLength(1);
    expect(batch.releasedWith[0]).toBeInstanceOf(Error);
  });

  test('a batch that fails is destroyed even when its ROLLBACK succeeds', async () => {
    const batch = new FakeClient((text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      throw timeout();
    });
    await expect(poller(poolOf(leaderWith(winsLock), batch)).sweep()).rejects.toThrow();
    expect(batch.releasedWith[0]).toBeInstanceOf(Error);
  });

  test('a leader whose lock query fails is destroyed', async () => {
    const leader = leaderWith((text) => {
      if (text.includes('pg_try_advisory_lock')) throw timeout();
      return { rows: [] };
    });
    await expect(poller(poolOf(leader)).sweep()).rejects.toThrow('Query read timeout');
    expect(leader.releasedWith[0]).toBeInstanceOf(Error);
  });

  test('a leader whose unlock fails is destroyed (it may still hold the advisory lock)', async () => {
    const leader = leaderWith((text) => {
      if (text.includes('pg_advisory_unlock')) throw timeout();
      return winsLock(text);
    });
    const emptyBatch = new FakeClient(() => ({ rows: [] }));
    await poller(poolOf(leader, emptyBatch)).sweep();
    expect(leader.releasedWith[0]).toBeInstanceOf(Error);
    // Control: the clean batch connection goes back to the pool.
    expect(emptyBatch.releasedWith).toEqual([undefined]);
  });

  test('a clean sweep returns the leader to the pool (control)', async () => {
    const leader = leaderWith(winsLock);
    await poller(poolOf(leader, new FakeClient(() => ({ rows: [] })))).sweep();
    expect(leader.releasedWith).toEqual([undefined]);
  });
});
