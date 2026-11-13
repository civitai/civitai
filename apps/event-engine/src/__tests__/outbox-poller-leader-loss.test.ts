// The outbox poller's single-active election is a SESSION advisory lock held on one `leader`
// connection. If that connection drops, Postgres releases the lock at once and another replica can
// take it on its next tick. With the pool guarded (src/utils/pg-pool-guard.ts) the drop no longer
// exits the process, so the sweep itself must stop claiming batches once its leader is gone, or two
// replicas sweep at the same time.
//
// Pool and clients are fakes: what is under test is the poller's reaction to an `'error'` emitted on
// its leader client, which is how pg reports a checked-out connection dropping (the guard tests drive
// that emit through a real pg Client).
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OutboxPoller } from '@/services/outbox-poller';

type Query = { text: string };

class FakeClient extends EventEmitter {
  queries: Query[] = [];
  released = 0;
  constructor(private respond: (text: string) => unknown) {
    super();
  }
  async query(text: string) {
    this.queries.push({ text });
    return this.respond(text);
  }
  release() {
    this.released++;
  }
}

function row(id: number) {
  return {
    id: String(id),
    event: 'create',
    entityType: 'Image',
    entityId: String(id),
    details: null,
    createdAt: new Date(0),
    attempts: 0,
  };
}

// A poller that ignores the drop keeps sweeping until the outbox is empty; this bounds it.
const ROWS_AVAILABLE_BATCHES = 10;

/**
 * A pool whose first checkout is the leader (always wins the lock) and every later checkout is a batch
 * client. Each batch returns a full page until ROWS_AVAILABLE_BATCHES pages have gone, so the sweep
 * would run that long unless the poller stops itself.
 */
function fakePool(batchSize: number) {
  let nextId = 1;
  const leader = new FakeClient((text) =>
    text.includes('pg_try_advisory_lock') ? { rows: [{ acquired: true }] } : { rows: [] }
  );
  const batches: FakeClient[] = [];
  let checkouts = 0;
  const pool = {
    connect: vi.fn(async () => {
      checkouts++;
      if (checkouts === 1) return leader;
      const client = new FakeClient((text) => {
        if (!text.includes('FOR UPDATE SKIP LOCKED')) return { rows: [] };
        if (batches.length > ROWS_AVAILABLE_BATCHES) return { rows: [] };
        const rows = Array.from({ length: batchSize }, () => row(nextId++));
        return { rows };
      });
      batches.push(client);
      return client;
    }),
    query: vi.fn(async () => ({ rows: [{ n: 0 }] })),
  };
  return { pool: pool as unknown as Pool, leader, batches };
}

describe('OutboxPoller after its leader connection drops', () => {
  test('claims no further batch once the lock connection errors', async () => {
    const batchSize = 3;
    const { pool, leader, batches } = fakePool(batchSize);
    let processed = 0;
    const poller = new OutboxPoller(
      pool,
      async () => {
        processed++;
        // The drop lands while the FIRST batch is being processed.
        if (processed === 1) leader.emit('error', new Error('Connection terminated unexpectedly'));
      },
      60_000,
      0,
      batchSize
    );

    await poller.sweep();

    // Positive control: the first batch really was claimed and processed before the drop.
    expect(processed).toBe(batchSize);
    expect(batches).toHaveLength(1);
    // The dead leader is handed back, and the listener this sweep added is gone.
    expect(leader.released).toBe(1);
    expect(leader.listenerCount('error')).toBe(0);
  });

  test('a healthy leader still drains until a batch comes back empty', async () => {
    const leader = new FakeClient((text) =>
      text.includes('pg_try_advisory_lock') ? { rows: [{ acquired: true }] } : { rows: [] }
    );
    let page = 0;
    const pool = {
      connect: vi.fn(async () => {
        if (pool.connect.mock.calls.length === 1) return leader;
        page++;
        return new FakeClient((text) =>
          text.includes('FOR UPDATE SKIP LOCKED') && page <= 2
            ? { rows: [row(page)] }
            : { rows: [] }
        );
      }),
      query: vi.fn(async () => ({ rows: [{ n: 0 }] })),
    };
    const seen: number[] = [];
    const poller = new OutboxPoller(
      pool as unknown as Pool,
      async (r) => void seen.push(r.id),
      60_000,
      0,
      1
    );

    await poller.sweep();

    expect(seen).toEqual([1, 2]);
    expect(leader.queries.some((q) => q.text.includes('pg_advisory_unlock'))).toBe(true);
    expect(leader.listenerCount('error')).toBe(0);
  });
});
