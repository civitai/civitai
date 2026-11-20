import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createPool } from '@civitai/db/db-helpers';
import { createCallerFactory, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { handleTRPCError, throwDbCustomError, throwDbError } from '~/server/utils/errorHandling';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';

// An unreachable database is a transient condition: a client should back off and retry (503), not
// read it as a server bug (500). A 503's message is NOT masked on the wire (client-safe-error.ts),
// and Prisma's text for these names the database host, so the message must be a generic one.

const HOST = 'db-internal-host.example:5432';
const p1001 = () =>
  new Prisma.PrismaClientKnownRequestError(`Can't reach database server at \`${HOST}\``, {
    code: 'P1001',
    clientVersion: 'test',
  });
const p2024 = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Timed out fetching a new connection from the connection pool',
    { code: 'P2024', clientVersion: 'test' }
  );
const initP1001 = () =>
  new Prisma.PrismaClientInitializationError(
    `Can't reach database server at \`${HOST}\``,
    'test',
    'P1001'
  );
// The same socket error from any dependency: unmarked, it cannot be told apart from Redis/S3/fetch.
const bareRefused = () =>
  Object.assign(new Error(`connect ECONNREFUSED ${HOST}`), { code: 'ECONNREFUSED' });
const fetchRefused = () => new TypeError('fetch failed', { cause: bareRefused() });
// A pg server error (pg's DatabaseError carries `severity` and a SQLSTATE `code`).
const pgAdminShutdown = () =>
  Object.assign(new Error('terminating connection due to administrator command'), {
    name: 'error',
    severity: 'FATAL',
    code: '57P01',
  });

/** The real error a `createPool` pool raises when the database refuses the connection. */
async function pgPoolRefused(): Promise<unknown> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const pool = createPool({
    connectionString: `postgresql://u:p@127.0.0.1:${port}/db`,
    ssl: false,
  });
  try {
    await pool.query('select 1');
    throw new Error('expected the connection to be refused');
  } catch (e) {
    return e;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// During a primary failover the pooler answers with a cached login failure, which Prisma wraps in an
// error that has no P-code.
const prismaWrappedLoginFailing = () =>
  new Prisma.PrismaClientUnknownRequestError(
    `Error in connector: Error querying the database: FATAL: server login has been failing, cached error: connect failed (server_login_retry) at ${HOST}`,
    { clientVersion: 'test' }
  );

const caught = (fn: () => unknown): TRPCError => {
  try {
    fn();
  } catch (e) {
    return e as TRPCError;
  }
  throw new Error('did not throw');
};

describe('throwDbError / handleTRPCError', () => {
  it.each([
    ['P1001', p1001],
    ['P2024 (pool acquire timeout)', p2024],
  ])('%s → SERVICE_UNAVAILABLE without the driver text', (_label, make) => {
    for (const fn of [throwDbError, handleTRPCError]) {
      const err = caught(() => fn(make()));
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
      expect(err.message).not.toContain(HOST);
      expect(err.message).not.toContain('connection pool');
    }
  });

  it("throwDbCustomError: a 503 carries the generic message, never the caller's or the driver's", () => {
    const err = caught(() => throwDbCustomError('Could not load the model')(p1001()));
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.message).toBe('This service is temporarily unavailable. Please try again.');
  });

  it("throwDbCustomError: any other code keeps the caller's message", () => {
    const e = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on `slug`', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const err = caught(() => throwDbCustomError('That slug is taken')(e));
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('That slug is taken');
  });

  // Control: a query fault keeps its mapping (and its message, which this change does not touch).
  it('P2002 stays CONFLICT', () => {
    const e = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(caught(() => throwDbError(e)).code).toBe('CONFLICT');
  });
});

describe('publicProcedure maps an uncaught unreachable-database error to 503', () => {
  const app = router({
    boom: publicProcedure.query(({ ctx }) => {
      throw (ctx as unknown as { toThrow: unknown }).toThrow;
    }),
  });
  const call = (toThrow: unknown) =>
    (
      createCallerFactory(app)({
        acceptableOrigin: true,
        features: {},
        tokenScope: TokenScope.Full,
        toThrow,
      } as never) as unknown as {
        boom: () => Promise<unknown>;
      }
    ).boom();

  it.each([
    ['Prisma init P1001', initP1001],
    ['Prisma known P1001', p1001],
    ['pg server admin shutdown (57P01)', pgAdminShutdown],
    ['pg-pool acquire timeout', () => new Error('timeout exceeded when trying to connect')],
    ['pg connect timeout', () => new Error('Connection terminated due to connection timeout')],
    ['Prisma unknown error wrapping a pooler login failure', prismaWrappedLoginFailing],
    // Any pg 08xxx is a 503, including an 08P01 whose message the read retry's list does not name.
    [
      'pg 08P01 with an unlisted pooler message',
      () =>
        Object.assign(new Error('client_login_timeout (server down)'), {
          severity: 'FATAL',
          code: '08P01',
        }),
    ],
    [
      'Prisma unknown error wrapping 57P03 not yet accepting connections',
      () =>
        new Prisma.PrismaClientUnknownRequestError(
          'Error in connector: Error querying the database: FATAL: the database system is not yet accepting connections',
          { clientVersion: 'test' }
        ),
    ],
    // Pool saturation is not retried (read-retry.ts) but is still a 503.
    [
      'pg 08P01 from the pooler: no more connections allowed',
      () =>
        Object.assign(new Error('no more connections allowed (max_client_conn)'), {
          severity: 'FATAL',
          code: '08P01',
        }),
    ],
    [
      'Prisma unknown error wrapping the pooler query_wait_timeout',
      () =>
        new Prisma.PrismaClientUnknownRequestError(
          'Error in connector: Error querying the database: ERROR: query_wait_timeout',
          { clientVersion: 'test' }
        ),
    ],
  ])('%s → SERVICE_UNAVAILABLE, generic message', async (_label, make) => {
    const err = (await call(make()).catch((e) => e)) as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.message).not.toContain(HOST);
  });

  it('a createPool connection refused → 503, and the re-map is logged without the host', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const err = (await call(await pgPoolRefused()).catch((e) => e)) as TRPCError;
      expect(err.code).toBe('SERVICE_UNAVAILABLE');
      const lines = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('db-unavailable-503'));
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(line).toMatchObject({ type: 'warning', path: 'boom', errorCode: 'ECONNREFUSED' });
      expect(lines[0]).not.toContain('127.0.0.1');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['a Redis-style ECONNREFUSED', bareRefused],
    ['a fetch to another service refused', fetchRefused],
  ])(
    '%s is not the database: stays INTERNAL_SERVER_ERROR, nothing logged as a re-map',
    async (_l, make) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const err = (await call(make()).catch((e) => e)) as TRPCError;
        expect(err.code).toBe('INTERNAL_SERVER_ERROR');
        expect(warn.mock.calls.some((c) => String(c[0]).includes('db-unavailable-503'))).toBe(
          false
        );
      } finally {
        warn.mockRestore();
      }
    }
  );

  it('a plain bug stays INTERNAL_SERVER_ERROR', async () => {
    const bug = new TypeError('x is undefined');
    const err = (await call(bug).catch((e) => e)) as TRPCError;
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    // The resolver itself was reached: the error is the one it threw, not a middleware's.
    expect(err.cause).toBe(bug);
  });

  it('a code a handler chose on purpose is kept even with a database cause', async () => {
    const chosen = new TRPCError({ code: 'NOT_FOUND', message: 'gone', cause: p1001() });
    const err = (await call(chosen).catch((e) => e)) as TRPCError;
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('handleEndpointError (REST) maps an unreachable database to 503', () => {
  function createRes() {
    let statusCode = 200;
    let body: unknown;
    const res = {
      headersSent: false,
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(b: unknown) {
        body = b;
        res.headersSent = true;
        return res;
      },
      setHeader: () => res,
      end: () => res,
      _status: () => statusCode,
      _body: () => body,
    };
    return res;
  }
  const respond = (e: unknown) => {
    const res = createRes();
    handleEndpointError(res as never, e);
    return res;
  };

  it.each([
    ['a bare Prisma P1001', p1001],
    ['a Prisma unknown error wrapping a pooler login failure', prismaWrappedLoginFailing],
    [
      'the same, wrapped by throwDbError',
      () => caught(() => throwDbError(prismaWrappedLoginFailing())),
    ],
  ])('%s → 503 with the generic message', (_label, make) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = respond(make());
      expect(res._status()).toBe(503);
      expect(res._body()).toEqual({
        message: 'This service is temporarily unavailable. Please try again.',
      });
      expect(JSON.stringify(res._body())).not.toContain(HOST);
    } finally {
      warn.mockRestore();
    }
  });
});
