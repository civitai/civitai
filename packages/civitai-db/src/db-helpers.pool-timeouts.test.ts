import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPool, queryWithTimeout } from './db-helpers';
import { isDbConnectionError } from './db-errors';
import { startFakePgServer, type FakePgServer } from './test-support/fake-pg-server';

// A real pg.Pool built by createPool, against servers that misbehave the way an outage does:
//   - a TCP listener that accepts and then never answers the startup handshake (a wedged or
//     black-holed database), and
//   - the fake Postgres server, which completes the handshake and then never answers a query (a
//     half-open connection).
// Every case asserts a literal time bound. Before the defaults, each of these waited forever.

type Outcome<T> = { kind: 'hung' } | { kind: 'ok'; value: T } | { kind: 'err'; error: Error };
/** Settles with the promise's outcome, or `hung` after `ms`. */
async function within<T>(p: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'hung' }), ms);
  });
  const start = Date.now();
  const outcome = await Promise.race<Outcome<T>>([
    p.then(
      (value): Outcome<T> => ({ kind: 'ok', value }),
      (error: Error): Outcome<T> => ({ kind: 'err', error })
    ),
    guard,
  ]);
  clearTimeout(timer);
  return { outcome, elapsed: Date.now() - start };
}
const errorMessage = (o: Outcome<unknown>) => (o.kind === 'err' ? o.error.message : o.kind);

async function startSilentServer() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgresql://user:pass@127.0.0.1:${port}/testdb`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

describe('createPool defaults bound every wait', () => {
  it('a database that never answers the handshake errors in under 6s', async () => {
    const server = await startSilentServer();
    cleanups.push(server.close);
    const pool = createPool({ connectionString: server.url, ssl: false });
    cleanups.push(() => pool.end());

    const { outcome, elapsed } = await within(pool.query('select 1'), 6_500);

    expect(outcome.kind, 'pool.query never settled').toBe('err');
    expect(elapsed).toBeLessThan(6_000);
  }, 10_000);

  it('waiting for a pooled connection while every slot is held errors in under 6s', async () => {
    const server: FakePgServer = await startFakePgServer();
    cleanups.push(server.close);
    const pool = createPool({ connectionString: server.url, ssl: false, max: 1 });
    cleanups.push(() => pool.end());
    const held = await pool.connect();
    cleanups.push(async () => held.release(true));

    const { outcome, elapsed } = await within(pool.connect(), 6_500);

    expect(errorMessage(outcome), 'pool.connect never settled').toBe(
      'timeout exceeded when trying to connect'
    );
    expect(elapsed).toBeLessThan(6_000);
  }, 10_000);

  // Invariant guard (also green before the change): a caller's own timeout is kept, not replaced
  // by the default. 300ms cannot equal the 5s default, so a hardcoded default would fail this.
  it("keeps a caller's own connectionTimeoutMillis", async () => {
    const server = await startSilentServer();
    cleanups.push(server.close);
    const pool = createPool({
      connectionString: server.url,
      ssl: false,
      connectionTimeoutMillis: 300,
    });
    cleanups.push(() => pool.end());

    const { outcome, elapsed } = await within(pool.query('select 1'), 3_000);

    expect(outcome.kind).toBe('err');
    expect(elapsed).toBeLessThan(1_500);
  });

  // Structural: Node exposes no getter for a socket's keepalive state, so the pool option is the
  // observable. It is what pg passes to `socket.setKeepAlive` on every connection.
  it('turns on TCP keepalive', () => {
    const pool = createPool({ connectionString: 'postgresql://u:p@127.0.0.1:1/db', ssl: false });
    cleanups.push(() => pool.end());
    expect((pool as unknown as { options: Record<string, unknown> }).options.keepAlive).toBe(true);
  });
});

describe('queryWithTimeout on a connection whose answer never comes', () => {
  it('errors shortly after its own timeout and destroys the client', async () => {
    const server = await startFakePgServer();
    cleanups.push(server.close);
    const pool = createPool({ connectionString: server.url, ssl: false, max: 1 });
    cleanups.push(() => pool.end());

    const { outcome, elapsed } = await within(queryWithTimeout(pool, 200, 'select 1'), 5_000);

    expect(errorMessage(outcome), 'queryWithTimeout never settled').toMatch(
      /^Query deadline exceeded/
    );
    expect(elapsed).toBeLessThan(3_500);
    // The wedged client was not handed back for the next caller to queue behind.
    expect(pool.totalCount).toBe(0);
  }, 10_000);
});

/** A local port with nothing listening: connecting to it is refused at once. */
async function refusedUrl() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `postgresql://user:pass@127.0.0.1:${port}/testdb`;
}

// A raw socket error counts as the DATABASE's only when createPool marked it while acquiring a
// connection (db-errors.ts). Kysely and queryWithTimeout acquire through the PROMISE form of
// pool.connect, a separate branch of the wrapper from the callback form pool.query uses.
describe('a refused connection is marked as database-originated', () => {
  it('pool.connect() (promise form) rejects with a marked ECONNREFUSED', async () => {
    const pool = createPool({ connectionString: await refusedUrl(), ssl: false });
    cleanups.push(() => pool.end());

    const { outcome } = await within(pool.connect(), 5_000);

    expect(outcome.kind).toBe('err');
    const error = (outcome as { error: Error & { code?: string } }).error;
    // POSITIVE CONTROL: it is the raw socket error, which db-errors.ts matches only when marked.
    expect(error.code).toBe('ECONNREFUSED');
    expect(
      isDbConnectionError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
      'an UNMARKED ECONNREFUSED classified as the database — this test cannot see the marking'
    ).toBe(false);
    expect(
      isDbConnectionError(error),
      'the promise-form connect error was not marked, so it reads as a generic 500'
    ).toBe(true);
  });

  it('queryWithTimeout surfaces the same marked error', async () => {
    const pool = createPool({ connectionString: await refusedUrl(), ssl: false });
    cleanups.push(() => pool.end());

    const { outcome } = await within(queryWithTimeout(pool, 1_000, 'select 1'), 5_000);

    expect(outcome.kind).toBe('err');
    const error = (outcome as { error: Error & { code?: string } }).error;
    expect(error.code).toBe('ECONNREFUSED');
    expect(isDbConnectionError(error)).toBe(true);
  });

  it('pool.query (callback form) rejects with a marked ECONNREFUSED', async () => {
    const pool = createPool({ connectionString: await refusedUrl(), ssl: false });
    cleanups.push(() => pool.end());

    const { outcome } = await within(pool.query('select 1'), 5_000);

    expect(outcome.kind).toBe('err');
    const error = (outcome as { error: Error & { code?: string } }).error;
    expect(error.code).toBe('ECONNREFUSED');
    expect(isDbConnectionError(error)).toBe(true);
  });
});
