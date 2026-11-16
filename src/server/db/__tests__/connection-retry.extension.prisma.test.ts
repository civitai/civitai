import { connectionRetryExtension } from '@civitai/db/connection-retry';
import { Prisma, PrismaClient } from '@civitai/db-schema';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The read retry through a real PrismaClient's `$extends`, so Prisma's own hook signature, operation
 * names and `query` chaining are what the retry sees. The engine is never reached: an inner
 * extension, applied after it, stands in for it and fails the first call with a closed-connection
 * error. (A read inside an interactive transaction needs a database: see the `.pg.test.ts`.)
 */

const closedConnection = () =>
  new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', {
    code: 'P1017',
    clientVersion: '6.13.0',
  });

const state = { calls: 0, failFirst: 1 };
const engine = async () => {
  state.calls += 1;
  if (state.calls <= state.failFirst) throw closedConnection();
  return [{ id: 1 }] as never;
};

const base = new PrismaClient({ datasourceUrl: 'postgresql://unused@127.0.0.1:1/unused' });
const onRetry = vi.fn();
// Query extensions run in the order they are applied, each `query` calling the next.
const client = base.$extends(connectionRetryExtension({ onRetry })).$extends({
  query: {
    $allModels: { findMany: engine, count: engine, create: engine, updateMany: engine },
    $queryRaw: engine,
  },
});

beforeEach(() => {
  state.calls = 0;
  state.failFirst = 1;
  onRetry.mockReset();
});
afterAll(() => base.$disconnect());

describe('the connection retry extension on a real Prisma client', () => {
  it('retries a model read once and returns the retry', async () => {
    await expect(client.user.findMany({ where: { id: 1 } })).resolves.toEqual([{ id: 1 }]);
    expect(state.calls).toBe(2);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'User', operation: 'findMany', result: 'ok' })
    );
  });

  it('retries a count', async () => {
    await client.user.count();
    expect(state.calls).toBe(2);
  });

  it('propagates a second failure', async () => {
    state.failFirst = 2;
    await expect(client.user.findMany()).rejects.toMatchObject({ code: 'P1017' });
    expect(state.calls).toBe(2);
  });

  it('never retries a write', async () => {
    state.failFirst = Infinity;
    await expect(client.user.create({ data: { username: 'x' } as never })).rejects.toMatchObject({
      code: 'P1017',
    });
    await expect(client.user.updateMany({ data: {} })).rejects.toMatchObject({ code: 'P1017' });
    expect(state.calls).toBe(2); // one attempt each
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('never retries $queryRaw, which may be a write', async () => {
    await expect(client.$queryRaw`SELECT 1`).rejects.toMatchObject({ code: 'P1017' });
    expect(state.calls).toBe(1);
  });

  it('does not retry a read in a batch $transaction', async () => {
    await expect(client.$transaction([client.user.findMany()])).rejects.toMatchObject({
      code: 'P1017',
    });
    expect(state.calls).toBe(1);
  });
});
