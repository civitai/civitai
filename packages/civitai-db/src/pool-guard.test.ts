import type { EventEmitter } from 'node:events';
import { Client, type Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPool } from './db-helpers';
import { createKyselyClients, sql } from './kysely';
import { startFakePgServer, type FakePgServer } from './test-support/fake-pg-server';

/**
 * A dropped connection must never surface as an `'error'` emit with no listener: Node throws, from a
 * socket callback, so the process dies. The two paths are described on `guardPool`.
 *
 * Drives a REAL `pg.Pool` against a fake server that drops the socket, so pg raises its own
 * `Connection terminated unexpectedly`. `trapErrorEmits` records each `'error'` emit with the listener
 * count it found; 0 is exactly where Node would have thrown.
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

/**
 * The guard's log lines for this drop, by message. The guard dedupes by Error OBJECT, not by drop: a
 * fake server's clean close yields one error, but a real failover (server FATAL, or a TCP reset) can
 * give a checked-out client two distinct errors, so two lines.
 */
function loggedLines() {
  return consoleError.mock.calls
    .filter((args) => String(args[1]).includes(TERMINATED))
    .map((args) => String(args[0]));
}

const factories: Array<[string, string, (url: string) => Pool]> = [
  ['createPool', 'node-pg', (url) => createPool({ connectionString: url, ssl: false })],
  [
    'createKyselyClients',
    'kysely',
    (url) => createKyselyClients({ connectionString: url, singleClient: true }).pool,
  ],
];

describe.each(factories)(
  '%s guards its pool against dropped connections',
  (_name, label, build) => {
    // For createKyselyClients, (a)'s no-unhandled-emit assertion is an INVARIANT guard: its pool-level
    // listener predates guardPool. Only the log-line assertion is new there.
    it('(a) an IDLE client dropped by the server does not raise an unhandled error on the pool', async () => {
      server = await startFakePgServer();
      pool = build(server.url);
      trapPool(pool, emits);

      const client = await pool.connect();
      client.release();
      server.dropAll();

      await waitForErrorOn('pool');
      expect(unhandled()).toEqual([]);
      expect(loggedLines()).toEqual([
        `[db:${label}] connection error (the pool discards the client)`,
      ]);
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
      expect(loggedLines()).toEqual([
        `[db:${label}] connection error (the pool discards the client)`,
      ]);
    });
  }
);

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

  it('(b) the REPLICA pool is guarded too: a dbRead query that loses its connection raises no unhandled error', async () => {
    // createKyselyClients does not return the replica pool, so trap every pg Client instead.
    const primary = await startFakePgServer();
    server = await startFakePgServer({ dropOnQuery: true });
    const originalEmit = Client.prototype.emit;
    trapErrorEmits(Client.prototype, 'client', emits);
    try {
      const { dbRead, pool: primaryPool } = createKyselyClients({
        connectionString: primary.url,
        replicaConnectionString: server.url,
      });
      pool = primaryPool;

      await expect(sql`SELECT 1`.execute(dbRead)).rejects.toThrow(TERMINATED);

      await waitForErrorOn('client');
      expect(unhandled()).toEqual([]);
      expect(loggedLines()).toEqual([
        '[db:kysely] connection error (the pool discards the client)',
      ]);
      await dbRead.destroy();
    } finally {
      Client.prototype.emit = originalEmit;
      await primary.close();
    }
  });
});
