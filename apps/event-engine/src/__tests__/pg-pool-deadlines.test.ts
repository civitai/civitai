// A stalled Postgres must turn the event processor's awaited queries into errors, not into a partition that
// silently stops while its consumer heartbeat keeps it in the group. Drives the REAL pool
// `new EventProcessor()` builds against a fake server that either authenticates and then never answers a
// query, or accepts the TCP connection and never says anything.
//
// The fake server mirrors the one in pg-pool-guard.test.ts.
import net from 'node:net';
import type { Pool } from 'pg';
import { afterEach, describe, expect, test, vi } from 'vitest';

const SSL_REQUEST_CODE = 80877103;
// AuthenticationOk ('R', len 8, 0) + ReadyForQuery ('Z', len 5, 'I')
const AUTH_OK_AND_READY = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);
// The first test in the file pays for transforming the whole handler graph on import.
const IMPORT_TIMEOUT_MS = 30_000;

async function startFakePgServer(mode: 'silent-after-auth' | 'never-auth') {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (mode === 'never-auth') return;
    let started = false;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (started) return; // swallow every query
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8 || buf.length < buf.readInt32BE(0)) return;
      const code = buf.readInt32BE(4);
      buf = buf.subarray(buf.readInt32BE(0));
      if (code === SSL_REQUEST_CODE) return void socket.write('N');
      started = true;
      socket.write(AUTH_OK_AND_READY);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgresql://user:pass@127.0.0.1:${port}/testdb`,
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
      }),
  };
}

let server: Awaited<ReturnType<typeof startFakePgServer>> | undefined;
let pool: Pool | undefined;

async function eventProcessorPool(
  mode: 'silent-after-auth' | 'never-auth',
  env: Record<string, string> = {}
): Promise<Pool> {
  server = await startFakePgServer(mode);
  // config reads the env at import, so set it before importing.
  vi.stubEnv('DATABASE_URL', server.url);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const { logger } = await import('@/utils/logger');
  vi.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
  const { EventProcessor } = await import('@/services/event-processor');
  return (new EventProcessor(1) as unknown as { pgPool: Pool }).pgPool;
}

async function settleWithin<T>(ms: number, work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<'hung'>((r) => (timer = setTimeout(() => r('hung'), ms)));
  try {
    return await Promise.race([
      work.then(
        () => 'resolved' as const,
        (err: Error) => err
      ),
      hung,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  await pool?.end().catch(() => {});
  pool = undefined;
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const FAST = { PG_QUERY_TIMEOUT_MS: '300', PG_CONNECTION_TIMEOUT_MS: '300' };

describe('EventProcessor pg pool deadlines', () => {
  test(
    'a query the server never answers rejects within the query timeout',
    async () => {
      pool = await eventProcessorPool('silent-after-auth', FAST);
      const started = Date.now();
      const outcome = await settleWithin(3000, pool.query('SELECT 1'));
      expect(outcome).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(2000);
    },
    IMPORT_TIMEOUT_MS
  );

  test(
    'a server that never completes the handshake fails the connect within the connection timeout',
    async () => {
      pool = await eventProcessorPool('never-auth', FAST);
      const started = Date.now();
      const outcome = await settleWithin(3000, pool.query('SELECT 1'));
      expect(outcome).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(2000);
    },
    IMPORT_TIMEOUT_MS
  );

  test(
    'defaults to a 5 s connection timeout and a 30 s query timeout when the env sets none',
    async () => {
      pool = await eventProcessorPool('silent-after-auth');
      const options = (pool as unknown as { options: Record<string, unknown> }).options;
      expect(options.connectionTimeoutMillis).toBe(5_000);
      expect(options.query_timeout).toBe(30_000);
    },
    IMPORT_TIMEOUT_MS
  );
});
