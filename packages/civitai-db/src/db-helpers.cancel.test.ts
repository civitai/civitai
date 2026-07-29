import { beforeEach, describe, expect, it, vi } from 'vitest';

// Re-derives the fix from #2437 (daceheg): cancellableQuery's cancel() must fire pg_cancel_backend over a
// fresh Client OUTSIDE the pool. The old code called pool.connect() a SECOND time, which deadlocks a
// saturated pool — every slot is held by a query awaiting cancellation and the cancel can never get a slot.
//
// `pg` is mocked so no DB is touched: a fake Pool hands out one connection (with a pinned processID and a
// query we can leave pending to keep `done` false), and a fake Client records how cancel() connects.

const h = vi.hoisted(() => {
  const state = {
    poolConnectCount: 0,
    clients: [] as Array<{
      options: any;
      connectCalls: number;
      endCalls: number;
      queries: Array<{ sql: string; params?: unknown[] }>;
    }>,
    // Controls the fake connection's in-flight query promise for the current cancellableQuery.
    resolveQuery: undefined as undefined | ((rows: unknown[]) => void),
  };
  const reset = () => {
    state.poolConnectCount = 0;
    state.clients = [];
    state.resolveQuery = undefined;
  };
  return { state, reset };
});

vi.mock('pg', () => {
  class FakePool {
    options: any;
    constructor(options: any) {
      this.options = options;
    }
    on() {}
    connect() {
      h.state.poolConnectCount++;
      const connection = {
        processID: 4242,
        query: () =>
          new Promise((resolve) => {
            h.state.resolveQuery = (rows: unknown[]) => resolve({ rows });
          }),
        release: () => {},
      };
      return Promise.resolve(connection);
    }
  }
  class FakeClient {
    rec: { options: any; connectCalls: number; endCalls: number; queries: any[] };
    constructor(options: any) {
      this.rec = { options, connectCalls: 0, endCalls: 0, queries: [] };
      h.state.clients.push(this.rec);
    }
    connect() {
      this.rec.connectCalls++;
      return Promise.resolve();
    }
    query(sql: string, params?: unknown[]) {
      this.rec.queries.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }
    end() {
      this.rec.endCalls++;
      return Promise.resolve();
    }
  }
  const types = {
    setTypeParser: () => {},
    builtins: { TIMESTAMP: 1114 },
  };
  return { Pool: FakePool, Client: FakeClient, types };
});

import { createPool } from './db-helpers';

const CONN = 'postgresql://user:pass@localhost:5432/testdb';

beforeEach(() => {
  h.reset();
});

describe('cancellableQuery cancel path', () => {
  it('cancels via a fresh out-of-pool Client — never a second pool.connect()', async () => {
    const pool = createPool({ connectionString: CONN, ssl: false });
    const handle = await pool.cancellableQuery('SELECT 1');
    expect(h.state.poolConnectCount).toBe(1); // one acquire for the query itself

    await handle.cancel();

    // The cancel must NOT have gone back to the pool (that is the deadlock).
    expect(h.state.poolConnectCount).toBe(1);
    // Exactly one out-of-pool Client, connected, used for pg_cancel_backend, and always closed.
    expect(h.state.clients).toHaveLength(1);
    const c = h.state.clients[0];
    expect(c.connectCalls).toBe(1);
    expect(c.endCalls).toBe(1);
    expect(c.queries).toHaveLength(1);
    expect(c.queries[0].sql).toContain('pg_cancel_backend');
    expect(c.queries[0].params).toEqual([4242]);
    // Connect is bounded so a best-effort cancel can't hang forever.
    expect(c.options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('is a no-op once the query has already settled (done flag)', async () => {
    const pool = createPool({ connectionString: CONN, ssl: false });
    const handle = await pool.cancellableQuery('SELECT 1');
    h.state.resolveQuery?.([]); // let the query finish → .finally sets done = true
    await handle.result();

    await handle.cancel();
    expect(h.state.clients).toHaveLength(0); // no cancel Client constructed
    expect(h.state.poolConnectCount).toBe(1);
  });
});
