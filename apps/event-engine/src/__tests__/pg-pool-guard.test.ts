// A dropped Postgres connection must not surface as a listenerless `'error'` emit on the
// EventProcessor's pool or its clients (the two paths are described on guardPool in
// packages/civitai-db/src/pool-guard.ts).
//
// Drives the REAL pool `new EventProcessor()` builds, so the wiring is under test, against a fake
// server that drops the socket. `trapErrorEmits` records each `'error'` emit with the listener count
// it found; 0 is exactly where Node would have thrown.
//
// The fake server mirrors packages/civitai-db/src/test-support/fake-pg-server.ts; this app cannot
// depend on that package (see src/utils/pg-pool-guard.ts).
import net from 'node:net';
import type { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type ErrorEmit = { target: 'pool' | 'client'; listeners: number; message: string };

const TERMINATED = 'Connection terminated unexpectedly';
const SSL_REQUEST_CODE = 80877103;
// AuthenticationOk ('R', len 8, 0) + ReadyForQuery ('Z', len 5, 'I')
const AUTH_OK_AND_READY = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);
// The first test in the file pays for transforming the whole handler graph on import.
const IMPORT_TIMEOUT_MS = 30_000;
const LOGGED = '[pg:event-processor] connection error (the pool discards the client)';

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
        if (code === SSL_REQUEST_CODE) return void socket.write('N');
        started = true;
        sockets.add(socket);
        socket.write(AUTH_OK_AND_READY);
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
let logged: Array<{ msg: string; message: unknown }>;

async function eventProcessorPool(dropOnQuery: boolean): Promise<Pool> {
  server = await startFakePgServer({ dropOnQuery });
  // config reads DATABASE_URL at import, so point it at the fake server before importing.
  vi.stubEnv('DATABASE_URL', server.url);
  vi.resetModules();
  const { logger } = await import('@/utils/logger');
  vi.spyOn(logger, 'error').mockImplementation(((
    obj: { error?: { message?: unknown } },
    msg: string
  ) => {
    logged.push({ msg, message: obj?.error?.message });
  }) as never);
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
  logged = [];
});

afterEach(async () => {
  await pool?.end().catch(() => {});
  await server?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('EventProcessor pg pool survives dropped connections', () => {
  test(
    '(a) an IDLE client dropped by the server does not raise an unhandled error on the pool',
    async () => {
      pool = await eventProcessorPool(false);
      const client = await pool.connect();
      client.release();
      server.dropAll();

      await waitForErrorOn('pool');
      expect(emits.filter((e) => e.listeners === 0)).toEqual([]);
      expect(logged).toEqual([{ msg: LOGGED, message: TERMINATED }]);
    },
    IMPORT_TIMEOUT_MS
  );

  test(
    '(b) a CHECKED-OUT client dropped mid-query does not raise an unhandled error on the client',
    async () => {
      pool = await eventProcessorPool(true);
      const client = await pool.connect();
      await expect(client.query('SELECT 1')).rejects.toThrow(TERMINATED);
      client.release();

      await waitForErrorOn('client');
      expect(emits.filter((e) => e.listeners === 0)).toEqual([]);
      expect(logged).toEqual([{ msg: LOGGED, message: TERMINATED }]);
    },
    IMPORT_TIMEOUT_MS
  );
});
