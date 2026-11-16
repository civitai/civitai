import { Prisma } from '@civitai/db-schema';
import { describe, expect, it, vi } from 'vitest';
import { isClosedConnectionError, runWithConnectionRetry } from './connection-retry';

/**
 * The retry wrapper with a fake `query` standing in for the next step of Prisma's chain. Each fake
 * fails a set number of times with a given error and then answers, and counts its calls, so every
 * case states both what the caller got and how many attempts were made.
 */

const closedConnection = () =>
  new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
    code: 'P1017',
    clientVersion: '6.13.0',
  });

const ROWS = [{ id: 7 }];

function failing(times: number, error: () => unknown) {
  let calls = 0;
  const query = vi.fn(async (_args: unknown) => {
    calls += 1;
    if (calls <= times) throw error();
    return ROWS;
  });
  return query;
}

const run = (
  operation: string,
  query: (args: unknown) => Promise<unknown>,
  extra: { transaction?: unknown } = {},
  onRetry = vi.fn()
) =>
  runWithConnectionRetry(
    {
      model: 'User',
      operation,
      args: { where: { id: 7 } },
      query,
      __internalParams: extra,
    },
    { onRetry }
  );

describe('runWithConnectionRetry', () => {
  it.each(['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy'])(
    'retries a %s that failed on a closed connection once, and returns the retry',
    async (operation) => {
      const query = failing(1, closedConnection);
      const onRetry = vi.fn();
      await expect(run(operation, query, {}, onRetry)).resolves.toBe(ROWS);
      expect(query).toHaveBeenCalledTimes(2);
      // The retry sends the same args.
      expect(query.mock.calls[1][0]).toEqual({ where: { id: 7 } });
      expect(onRetry).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'User', operation, result: 'ok' })
      );
    }
  );

  it.each(['create', 'update', 'upsert', 'delete', 'updateMany', 'deleteMany', 'createMany'])(
    'never retries a %s, which may already have committed',
    async (operation) => {
      const query = failing(1, closedConnection);
      await expect(run(operation, query)).rejects.toMatchObject({ code: 'P1017' });
      expect(query).toHaveBeenCalledTimes(1);
    }
  );

  it('does not retry a read that failed for any other reason', async () => {
    const notFound = () =>
      new Prisma.PrismaClientKnownRequestError('No record found', {
        code: 'P2025',
        clientVersion: '6.13.0',
      });
    const query = failing(1, notFound);
    await expect(run('findUniqueOrThrow', query)).rejects.toMatchObject({ code: 'P2025' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('propagates the second failure when the retry also hits a closed connection', async () => {
    const query = failing(5, closedConnection);
    const onRetry = vi.fn();
    await expect(run('findMany', query, {}, onRetry)).rejects.toMatchObject({ code: 'P1017' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ result: 'failed' }));
  });

  it.each([
    ['an interactive', { kind: 'itx', id: 'tx-1' }],
    ['a batch', { kind: 'batch', id: 1, index: 0 }],
  ])('does not retry a read inside %s transaction', async (_name, transaction) => {
    const query = failing(1, closedConnection);
    await expect(run('findMany', query, { transaction })).rejects.toMatchObject({
      code: 'P1017',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns the first answer without a second call when nothing fails', async () => {
    const query = failing(0, closedConnection);
    await expect(run('findMany', query)).resolves.toBe(ROWS);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('isClosedConnectionError', () => {
  it('matches P1017 and the uncoded closed-connection message', () => {
    expect(isClosedConnectionError(closedConnection())).toBe(true);
    expect(
      isClosedConnectionError(
        new Prisma.PrismaClientUnknownRequestError(
          'Error in PostgreSQL connection: Error { kind: Closed, cause: None }',
          { clientVersion: '6.13.0' }
        )
      )
    ).toBe(true);
  });

  it('matches P1017 by its code alone, whatever its message says', () => {
    const reworded = new Prisma.PrismaClientKnownRequestError('connection lost', {
      code: 'P1017',
      clientVersion: '6.13.0',
    });
    expect(isClosedConnectionError(reworded)).toBe(true);
  });

  it('matches a Prisma error from another copy of the runtime, by name and code', () => {
    const foreign = Object.assign(new Error('Server has closed the connection.'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P1017',
    });
    expect(isClosedConnectionError(foreign)).toBe(true);
  });

  it('ignores other errors, including a non-Prisma error with the same words', () => {
    expect(
      isClosedConnectionError(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.13.0',
        })
      )
    ).toBe(false);
    expect(isClosedConnectionError(new Error('Server has closed the connection'))).toBe(false);
    expect(isClosedConnectionError(undefined)).toBe(false);
    expect(isClosedConnectionError('P1017')).toBe(false);
  });
});
