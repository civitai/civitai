// A dropped Postgres connection must not surface as a listenerless `'error'` event on the
// EventProcessor's pool or its clients: `emit('error')` with no listener throws from a socket
// callback, and here that uncaught exception shuts the whole consumer down (src/index.ts).
//
// Drives the REAL pool `new EventProcessor()` builds — so the wiring is under test, not just the
// helper — against a fake server that drops the socket, so pg raises its own
// `Connection terminated unexpectedly`. Two paths, each needing its own listener:
//   (a) an IDLE client dies   -> pg-pool re-emits on the POOL;
//   (b) a CHECKED-OUT client dies mid-query -> emitted on the CLIENT only (pg-pool removes its own
//       client listener while a client is checked out).
// `trapErrorEmits` records each `'error'` emit with the listener count it found; 0 is exactly the
// case in which Node would have thrown.
//
// The fake server mirrors packages/civitai-db/src/test-support/fake-pg-server.ts; this app does not
// depend on that package (see src/utils/pg-pool-guard.ts).
import net from 'node:net';
import type { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type ErrorEmit = { target: 'pool' | 'client'; listeners: number; message: string };

const TERMINATED = 'Connection terminated unexpectedly';

async function startFakePgServer({ dropOnQuery = false } = {}) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    let started = false;
    let buf = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!started) {
        if (buf.length < 8 || buf.length < buf.readInt32BE(0)) return;
        const code = buf.readInt32BE(4);
        buf = buf.subarray(buf.readInt32BE(0));
        if (code === 80877103) return void socket.write('N'); // SSLRequest: no SSL
        started = true;
        sockets.add(socket);
        // AuthenticationOk + ReadyForQuery(idle)
        socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
        return;
      }
      if (dropOnQuery && buf.length > 0) socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgresql://user:pass@127.0.0.1:${port}/testdb`,
    dropAll: () => sockets.forEach((s) => s.destroy()),
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
      }),
  };
}

function trapErrorEmits(emitter: EventEmitter, target: ErrorEmit['target'], sink: ErrorEmit[]) {
  const original = emitter.emit;
  emitter.emit = function (this: EventEmitter, event: string | symbol, ...args: unknown[]) {
    if (event !== 'error') return original.call(this, event, ...args);
    const listeners = this.listenerCount('error');
    sink.push({ target, listeners, message: (args[0] as Error | undefined)?.message ?? '' });
    if (listeners === 0) return false; // Node would throw here
    return original.call(this, event, ...args);
  } as typeof emitter.emit;
}

let server: Awaited<ReturnType<typeof startFakePgServer>>;
let pool: Pool;
let emits: ErrorEmit[];

async function eventProcessorPool(dropOnQuery: boolean): Promise<Pool> {
  server = await startFakePgServer({ dropOnQuery });
  // config reads DATABASE_URL at import, so point it at the fake server before importing.
  vi.stubEnv('DATABASE_URL', server.url);
  vi.resetModules();
  const { EventProcessor } = await import('@/services/event-processor');
  const built = (new EventProcessor(1) as unknown as { pgPool: Pool }).pgPool;
  trapErrorEmits(built, 'pool', emits);
  built.on('connect', (client) => trapErrorEmits(client, 'client', emits));
  return built;
}

async function waitForErrorOn(target: ErrorEmit['target']) {
  await vi.waitFor(() => {
    expect(emits.some((e) => e.target === target && e.message === TERMINATED)).toBe(true);
  });
}

beforeEach(() => {
  emits = [];
});

afterEach(async () => {
  await pool?.end().catch(() => {});
  await server?.close();
  vi.unstubAllEnvs();
});

describe('EventProcessor pg pool survives dropped connections', () => {
  test('(a) an IDLE client dropped by the server does not raise an unhandled error on the pool', async () => {
    pool = await eventProcessorPool(false);
    const client = await pool.connect();
    client.release();
    server.dropAll();

    await waitForErrorOn('pool');
    expect(emits.filter((e) => e.listeners === 0)).toEqual([]);
  });

  test('(b) a CHECKED-OUT client dropped mid-query does not raise an unhandled error on the client', async () => {
    pool = await eventProcessorPool(true);
    const client = await pool.connect();
    await expect(client.query('SELECT 1')).rejects.toThrow(TERMINATED);
    client.release();

    await waitForErrorOn('client');
    expect(emits.filter((e) => e.listeners === 0)).toEqual([]);
  });
});
