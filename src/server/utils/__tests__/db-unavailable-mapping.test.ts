import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { createCallerFactory, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { handleTRPCError, throwDbError } from '~/server/utils/errorHandling';

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
const pgRefused = () =>
  Object.assign(new Error(`connect ECONNREFUSED ${HOST}`), { code: 'ECONNREFUSED' });

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
    ['pg ECONNREFUSED', pgRefused],
    ['pg-pool acquire timeout', () => new Error('timeout exceeded when trying to connect')],
    ['pg connect timeout', () => new Error('Connection terminated due to connection timeout')],
  ])('%s → SERVICE_UNAVAILABLE, generic message', async (_label, make) => {
    const err = (await call(make()).catch((e) => e)) as TRPCError;
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe('SERVICE_UNAVAILABLE');
    expect(err.message).not.toContain(HOST);
  });

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
