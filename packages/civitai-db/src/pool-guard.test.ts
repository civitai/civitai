import type { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from './db-helpers';
import { createKyselyClients, sql } from './kysely';
import { startFakePgServer, type FakePgServer } from './test-support/fake-pg-server';

/**
 * A pg pool must never let a dropped connection surface as an `'error'` event with no listener.
 *
 * `'error'` is special in Node: `emit('error')` with no listener THROWS, and because pg emits from a
 * socket callback the throw is an uncaught exception, which ends the process. A database failover
 * produces exactly that, on every open connection at once, along two paths:
 *
 *   (a) IDLE client dies   -> pg-pool re-emits the error on the POOL.
 *   (b) CHECKED-OUT client dies mid-query -> the error is emitted on the CLIENT. pg-pool removes its
 *       own client `'error'` listener while a client is checked out (pg-pool 3.10, `_acquireClient`),
 *       so a pool-level listener does not cover this path; only a per-client listener does.
 *
 * These tests drive a REAL `pg.Pool` against a fake server that drops the socket, so pg raises its
 * own `Connection terminated unexpectedly`. Rather than let a listenerless emit throw inside the test
 * worker, `trapErrorEmits` records each `'error'` emit with the listener count it found: a count of 0
 * is precisely the case in which Node would have thrown.
 */

type ErrorEmit = { target: 'pool' | 'client'; listeners: number; message: string };

function trapErrorEmits(emitter: EventEmitter, target: ErrorEmit['target'], sink: ErrorEmit[]) {
  const original = emitter.emit;
  emitter.emit = function (this: EventEmitter, event: string | symbol, ...args: unknown[]) {
    if (event !== 'error') return original.call(this, event, ...args);
    const listeners = this.listenerCount('error');
    sink.push({ target, listeners, message: (args[0] as Error | undefined)?.message ?? '' });
    // Node throws here when nothing listens; swallow it so the test can assert on the record.
    if (listeners === 0) return false;
    return original.call(this, event, ...args);
  } as typeof emitter.emit;
}

/** Trap the pool's own emits, and every client's from the moment the pool creates it. */
function trapPool(pool: Pool, sink: ErrorEmit[]) {
  trapErrorEmits(pool, 'pool', sink);
  pool.on('connect', (client) => trapErrorEmits(client, 'client', sink));
}

const TERMINATED = 'Connection terminated unexpectedly';

let server: FakePgServer;
let pool: Pool | undefined;
let emits: ErrorEmit[];
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  emits = [];
  pool = undefined;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await pool?.end().catch(() => {});
  await server?.close();
  consoleError.mockRestore();
});

const unhandled = () => emits.filter((e) => e.listeners === 0);

/** Positive control: the drop really did reach `target` as an error emit. */
async function waitForErrorOn(target: ErrorEmit['target']) {
  await vi.waitFor(() => {
    expect(emits.some((e) => e.target === target && e.message === TERMINATED)).toBe(true);
  });
}

function expectLogged() {
  const lines = consoleError.mock.calls.map((args) => args.map(String).join(' '));
  expect(lines.some((line) => line.startsWith('[db') && line.includes(TERMINATED))).toBe(true);
}

const factories: Array<[string, (url: string) => Pool]> = [
  ['createPool', (url) => createPool({ connectionString: url, ssl: false })],
  [
    'createKyselyClients',
    (url) => createKyselyClients({ connectionString: url, singleClient: true }).pool,
  ],
];

describe.each(factories)('%s guards its pool against dropped connections', (_name, build) => {
  // For createKyselyClients, (a) is an INVARIANT guard: its pool-level listener predates guardPool.
  // Every other case here was red before guardPool.
  it('(a) an IDLE client dropped by the server does not raise an unhandled error on the pool', async () => {
    server = await startFakePgServer();
    pool = build(server.url);
    trapPool(pool, emits);

    const client = await pool.connect();
    client.release(); // back to idle
    server.dropAll();

    await waitForErrorOn('pool');
    expect(unhandled()).toEqual([]);
    expectLogged();
  });

  it('(b) a CHECKED-OUT client dropped mid-query does not raise an unhandled error on the client', async () => {
    server = await startFakePgServer({ dropOnQuery: true });
    pool = build(server.url);
    trapPool(pool, emits);

    const client = await pool.connect();
    await expect(client.query('SELECT 1')).rejects.toThrow(TERMINATED);
    client.release();

    await waitForErrorOn('client');
    expect(unhandled()).toEqual([]);
    expectLogged();
  });
});

describe('createKyselyClients through Kysely itself', () => {
  it('(b) a query that loses its connection rejects at the call site without an unhandled client error', async () => {
    server = await startFakePgServer({ dropOnQuery: true });
    const { db, pool: kyselyPool } = createKyselyClients({
      connectionString: server.url,
      singleClient: true,
    });
    pool = kyselyPool;
    trapPool(pool, emits);

    await expect(sql`SELECT 1`.execute(db)).rejects.toThrow(TERMINATED);

    await waitForErrorOn('client');
    expect(unhandled()).toEqual([]);
  });
});
