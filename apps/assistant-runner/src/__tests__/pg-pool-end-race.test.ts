import net from 'node:net';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../core/pg-pool';

// `pool.end()` resolves as soon as pg-pool has handed each idle client its Terminate, not when the
// sockets close, and the idle client still carries the pool's error forwarder. A server that answers
// in that window with FATAL 57P01 (what `drop database … with (force)` and a failover send) makes the
// POOL emit 'error'. With no listener there that is an uncaught exception: it is how a test that ends
// its pool and then force-drops its database failed CI, and how a pool without a listener would
// crash on a failover. The fake server below sends that FATAL in answer to the Terminate.

const SSL_REQUEST_CODE = 80877103;

function authOkAndReady(): Buffer {
  return Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);
}

function fatal57P01(): Buffer {
  const fields = Buffer.concat([
    Buffer.from('SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0'),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(5);
  header.write('E', 0);
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

async function startTerminatingServer() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let started = false;
    let buf = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!started) {
        if (buf.length < 8 || buf.length < buf.readInt32BE(0)) return;
        const code = buf.readInt32BE(4);
        buf = buf.subarray(buf.readInt32BE(0));
        if (code === SSL_REQUEST_CODE) return void socket.write('N');
        started = true;
        socket.write(authOkAndReady());
        return;
      }
      // 'X' Terminate: answer it as a server being shut down / force-dropped would.
      if (buf[0] === 0x58) {
        socket.write(fatal57P01());
        socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgresql://u:p@127.0.0.1:${port}/db`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('a FATAL arriving while pool.end() closes an idle client', () => {
  // Positive control: the window is real. A bare pg.Pool emits 'error' AFTER end() resolved (a
  // listener is attached here only so the control does not crash the run).
  it('a bare pg.Pool emits error on the pool after end() has resolved', async () => {
    const server = await startTerminatingServer();
    closers.push(server.close);
    const pool = new pg.Pool({ connectionString: server.url });
    const errors: Error[] = [];
    (await pool.connect()).release();
    await pool.end();
    pool.on('error', (err) => errors.push(err));
    await settle();
    expect(errors.map((e) => (e as Error & { code?: string }).code)).toEqual(['57P01']);
  });

  it("the runner's createPool logs it and nothing is thrown", async () => {
    const server = await startTerminatingServer();
    closers.push(server.close);
    const logError = vi.fn();
    const pool = createPool({ connectionString: server.url }, 'test', logError);
    (await pool.connect()).release();
    await pool.end();
    await settle();
    expect(logError).toHaveBeenCalledTimes(1);
    expect((logError.mock.calls[0][1] as Error & { code?: string }).code).toBe('57P01');
  });
});
