import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { DatabaseError } from 'pg';
import { TRPCError } from '@trpc/server';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { throwBadRequestError, throwDbError } from '~/server/utils/errorHandling';

const CLIENT_VERSION = '6.13.0';

const READ_ONLY_TEXT =
  'Invalid `prisma.apiKey.create()` invocation:\n\nError occurred during query execution:\n' +
  'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { ' +
  'code: "25006", message: "cannot execute INSERT in a read-only transaction", severity: "ERROR" }) })';

function caught(fn: () => unknown): TRPCError {
  try {
    fn();
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error('expected a throw');
}

function expectMasked(error: TRPCError, leaked: string[], generic: string) {
  const safe = getClientSafeError(error);
  expect(safe, 'a driver-authored message must be masked').toBeDefined();
  for (const secret of leaked) expect(safe!.message).not.toContain(secret);
  expect(safe!.message).toBe(`${generic} (ref: ${safe!.errorRef})`);
  expect(safe!.errorRef).toMatch(/^[0-9a-f]{12}$/);
}

describe('getClientSafeError', () => {
  it('masks the Sep 21-22 read-only-transaction error that reached users verbatim', () => {
    const driver = new Prisma.PrismaClientUnknownRequestError(READ_ONLY_TEXT, {
      clientVersion: CLIENT_VERSION,
    });
    const error = caught(() => throwDbError(driver));

    expect(error.code).toBe('INTERNAL_SERVER_ERROR');
    expectMasked(
      error,
      ['prisma', '25006', 'read-only', 'apiKey', 'PostgresError'],
      'An unexpected error occurred'
    );
  });

  it('masks a driver error that escaped without throwDbError (tRPC wraps it, keeping its message)', () => {
    const driver = new Prisma.PrismaClientUnknownRequestError(READ_ONLY_TEXT, {
      clientVersion: CLIENT_VERSION,
    });
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: driver });

    expect(error.message).toBe(READ_ONLY_TEXT);
    expectMasked(error, ['prisma', '25006'], 'An unexpected error occurred');
  });

  it('keeps a 4xx status generic rather than turning it into a server-error message', () => {
    const driver = new Prisma.PrismaClientKnownRequestError(
      'Invalid `prisma.model.update()` invocation: An operation failed because it depends on one or more records that were required but not found.',
      { code: 'P2025', clientVersion: CLIENT_VERSION }
    );
    const error = caught(() => throwDbError(driver));

    expect(error.code).toBe('NOT_FOUND');
    expectMasked(error, ['prisma.model.update'], 'Not found');
  });

  it('masks pg DatabaseError text, which carries row values in `detail`', () => {
    const driver = new DatabaseError(
      'duplicate key value violates unique constraint "User_email_key"',
      0,
      'error'
    );
    driver.code = '23505';
    driver.detail = 'Key (email)=(victim@example.com) already exists.';
    const error = new TRPCError({ code: 'CONFLICT', message: driver.message, cause: driver });

    expectMasked(
      error,
      ['User_email_key', 'victim@example.com'],
      'The request conflicts with the current state'
    );
  });

  it('masks a socket error, whose message names the internal host and port', () => {
    const socket = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
      code: 'ECONNREFUSED',
    });
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: socket });

    expectMasked(error, ['10.1.2.3', 'ECONNREFUSED'], 'An unexpected error occurred');
  });

  it('leaves our own message alone when a socket error is only its cause', () => {
    const socket = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
      code: 'ECONNREFUSED',
    });
    const error = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Generation is temporarily unavailable',
      cause: socket,
    });

    expect(getClientSafeError(error)).toBeUndefined();
  });

  it.each([
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['TOO_MANY_REQUESTS', 429],
    ['SERVICE_UNAVAILABLE', 503],
  ] as const)(
    'leaves %s alone, matching REST — onError never logs it, so a ref would be unfindable',
    (code) => {
      const driver = new Prisma.PrismaClientUnknownRequestError(READ_ONLY_TEXT, {
        clientVersion: CLIENT_VERSION,
      });
      const error = new TRPCError({ code, message: driver.message, cause: driver });

      expect(getClientSafeError(error)).toBeUndefined();
    }
  );

  it('leaves a message we wrote alone, even when a driver error is its cause', () => {
    const driver = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on slug', {
      code: 'P2002',
      clientVersion: CLIENT_VERSION,
    });
    const error = caught(() => throwBadRequestError('That slug is already taken', driver));

    expect(getClientSafeError(error)).toBeUndefined();
  });

  it('leaves a hand-written 500 alone', () => {
    const error = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to create the collection',
    });

    expect(getClientSafeError(error)).toBeUndefined();
  });

  it('returns one ref per error, so the Axiom log line and the response carry the same one', () => {
    const driver = new Prisma.PrismaClientUnknownRequestError(READ_ONLY_TEXT, {
      clientVersion: CLIENT_VERSION,
    });
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: driver });
    const other = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: driver });

    const fromOnError = getClientSafeError(error)!.errorRef;
    expect(getClientSafeError(error)!.errorRef).toBe(fromOnError);
    expect(getClientSafeError(other)!.errorRef).not.toBe(fromOnError);
  });
});
