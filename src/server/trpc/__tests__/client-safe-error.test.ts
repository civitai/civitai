import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { throwDbError } from '~/server/utils/errorHandling';

const READ_ONLY_TEXT =
  'Invalid `prisma.apiKey.create()` invocation:\n\nError occurred during query execution:\n' +
  'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { ' +
  'code: "25006", message: "cannot execute INSERT in a read-only transaction", severity: "ERROR" }) })';

const readOnlyError = () =>
  new Prisma.PrismaClientUnknownRequestError(READ_ONLY_TEXT, { clientVersion: '6.13.0' });

function expectMasked(error: TRPCError) {
  const safe = getClientSafeError(error);
  expect(safe, 'a server fault must be masked').toBeDefined();
  expect(safe!.errorRef).toMatch(/^[0-9a-f]{12}$/);
  expect(safe!.message).toBe(`An unexpected error occurred (ref: ${safe!.errorRef})`);
}

describe('getClientSafeError', () => {
  it('masks the Sep 21-22 read-only-transaction error that reached users verbatim', () => {
    let error: TRPCError | undefined;
    try {
      throwDbError(readOnlyError());
    } catch (e) {
      error = e as TRPCError;
    }

    expect(error?.code).toBe('INTERNAL_SERVER_ERROR');
    expectMasked(error!);
  });

  it('masks a raw error tRPC wrapped as a 500', () => {
    const socket = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
      code: 'ECONNREFUSED',
    });

    expectMasked(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: socket }));
  });

  it('masks a 500 message we wrote too — the user cannot act on a server fault', () => {
    expectMasked(
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create the collection' })
    );
  });

  it.each(['TIMEOUT', 'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'SERVICE_UNAVAILABLE'])(
    'leaves %s alone',
    (code) => {
      const error = new TRPCError({
        code: code as TRPC_ERROR_CODE_KEY,
        message: 'That slug is already taken',
      });

      expect(getClientSafeError(error)).toBeUndefined();
    }
  );

  it('returns one ref per error, so the Axiom log line and the response carry the same one', () => {
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: readOnlyError() });
    const other = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: readOnlyError() });

    const fromOnError = getClientSafeError(error)!.errorRef;
    expect(getClientSafeError(error)!.errorRef).toBe(fromOnError);
    expect(getClientSafeError(other)!.errorRef).not.toBe(fromOnError);
  });

  it('returns the same ref from two bundled copies of this module', async () => {
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: readOnlyError() });

    vi.resetModules();
    const copyA = await import('~/server/trpc/client-safe-error');
    vi.resetModules();
    const copyB = await import('~/server/trpc/client-safe-error');

    expect(copyA.getClientSafeError).not.toBe(copyB.getClientSafeError);
    expect(copyB.getClientSafeError(error)!.errorRef).toBe(
      copyA.getClientSafeError(error)!.errorRef
    );
  });
});
