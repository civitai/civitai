import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins the `.catch(() => {})` on `cancellableQuery`'s cleanup chain.
 *
 * `query.finally(...)` DERIVES a second promise. Nothing holds it, so on a failing statement it
 * raises `unhandledRejection` — and Node >=15 exits the process by default. Awaiting `result()`
 * does NOT prevent that: it handles `query`, while the derived promise is a separate object with
 * no handler on any path. The failure therefore looks like the worker simply vanishing, on a
 * statement whose caller had a perfectly good `.catch` around it.
 *
 * Without a test this is defended by a comment alone, which is how it shipped half-fixed once
 * already: an audit removed the `.catch`, ran the full package tier, and all 1,273 tests stayed
 * green. This file is the mutant-killer for exactly that edit — delete the `.catch` in
 * `db-helpers.ts` and the first case here goes red.
 *
 * `pg` is faked, so no database is touched. Same idiom as db-helpers.cancel.test.ts.
 */

const h = vi.hoisted(() => {
  const state = {
    released: 0,
    rejectQuery: undefined as undefined | ((err: Error) => void),
  };
  return { state };
});

vi.mock('pg', () => {
  class FakePool {
    options: any;
    constructor(options: any) {
      this.options = options;
    }
    on() {}
    connect() {
      return Promise.resolve({
        processID: 1234,
        // A query that stays pending until the test decides to fail it — the real shape, where
        // cancellableQuery resolves on DISPATCH and the statement fails later.
        query: () =>
          new Promise((_resolve, reject) => {
            h.state.rejectQuery = (err: Error) => reject(err);
          }),
        release: () => {
          h.state.released++;
        },
      });
    }
  }
  class FakeClient {
    constructor(public options: any) {}
    connect() {
      return Promise.resolve();
    }
    query() {
      return Promise.resolve({ rows: [] });
    }
    end() {
      return Promise.resolve();
    }
  }
  return {
    Pool: FakePool,
    Client: FakeClient,
    types: { setTypeParser: () => {}, builtins: { TIMESTAMP: 1114 } },
    default: { Pool: FakePool, Client: FakeClient },
  };
});

const { createPool } = await import('./db-helpers');

let unhandled: unknown[] = [];
const record = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  h.state.released = 0;
  h.state.rejectQuery = undefined;
  // Vitest installs its own handler and would otherwise fail the run for us; capture instead, so
  // the assertion is about the COUNT rather than about the runner's reaction.
  process.on('unhandledRejection', record);
});

afterEach(() => {
  process.off('unhandledRejection', record);
});

/** Give the microtask queue and one macrotask turn a chance to surface an unhandled rejection. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('cancellableQuery rejection handling', () => {
  it('raises NO unhandled rejection when a dispatched statement fails', async () => {
    const pool = createPool({ connectionString: 'postgres://u:p@h:5432/d' });
    const handle = await pool.cancellableQuery('UPDATE "T" SET a = 1', []);

    // The caller's own handler, exactly as the push dispatcher's bestEffort does it.
    const caught: string[] = [];
    const awaited = handle.result().catch((e: Error) => caught.push(e.message));

    h.state.rejectQuery!(new Error('statement failed'));
    await awaited;
    await settle();

    // The rejection the caller asked for still reaches the caller...
    expect(caught).toEqual(['statement failed']);
    // ...and the derived cleanup promise does not take the process down with it.
    expect(unhandled).toEqual([]);
  });

  it('still releases the connection when the statement fails', async () => {
    const pool = createPool({ connectionString: 'postgres://u:p@h:5432/d' });
    const handle = await pool.cancellableQuery('UPDATE "T" SET a = 1', []);
    const awaited = handle.result().catch(() => undefined);

    h.state.rejectQuery!(new Error('statement failed'));
    await awaited;
    await settle();

    // The whole point of the .finally the .catch is attached to. Swallowing the rejection must not
    // cost the release — a leaked pool connection would be worse than the crash it prevents.
    expect(h.state.released).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('raises no unhandled rejection even when NOTHING awaits result()', async () => {
    const pool = createPool({ connectionString: 'postgres://u:p@h:5432/d' });
    await pool.cancellableQuery('UPDATE "T" SET a = 1', []);

    // A fire-and-forget write. There is no such call site in this monorepo today, but the helper
    // must not turn one into a process exit if somebody adds it.
    h.state.rejectQuery!(new Error('statement failed'));
    await settle();

    expect(unhandled).toEqual([]);
    expect(h.state.released).toBe(1);
  });
});
