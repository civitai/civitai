import { describe, expect, it } from 'vitest';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis, sysRedis } from '~/server/redis/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { mockNode } from '~/__tests__/mocks/hybrid';

describe('shared-module mocks', () => {
  it('routes the real specifier to the canonical mock', () => {
    expect(dbRead).toBe(dbMock.dbRead);
    expect(dbWrite).toBe(dbMock.dbWrite);
    expect(redis).toBe(redisMock.redis);
    expect(sysRedis).toBe(redisMock.sysRedis);
  });

  it('keeps dbRead and dbWrite distinct', () => {
    // Hand-written mocks routinely aliased these to one object, which let a dbWrite call
    // satisfy a dbRead assertion. Aliasing them back would preserve tests that pass for
    // the wrong reason.
    expect(dbMock.dbRead).not.toBe(dbMock.dbWrite);
    expect(dbMock.dbRead.image.findMany).not.toBe(dbMock.dbWrite.image.findMany);
  });

  it('vivifies to a STABLE identity at any depth', () => {
    // The whole design rests on this: a consumer module caches its binding at first
    // evaluation and never re-reads it, so the node it captured must stay the node the
    // test configures.
    expect(dbMock.dbRead.image.findMany).toBe(dbMock.dbRead.image.findMany);
    expect(redisMock.redis.packed.get).toBe(mockNode('redis.packed.get'));
    expect(dbMock.dbRead.$queryRaw).toBe(mockNode('dbRead.$queryRaw'));
  });

  it('spreads the original module, so non-client exports survive', async () => {
    // `~/server/db/client` re-exports @civitai/db/client wholesale. Replacing the module
    // instead of spreading it is what produces `No "X" export is defined on the mock` in
    // a file that never mocked anything.
    const dbClient = await import('~/server/db/client');
    expect(Object.keys(dbClient).length).toBeGreaterThan(2);
    const redisClient = await import('~/server/redis/client');
    expect(redisClient.withSysReadDeadline).toBeTypeOf('function');
  });

  it('is never mistaken for a thenable', async () => {
    // A node resolving `then` to a child would make it callable by the await machinery,
    // which hangs rather than fails.
    expect((dbMock.dbRead as unknown as { then: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(dbMock.dbRead)).resolves.toBe(dbMock.dbRead);
  });

  it('applies read-shaped defaults so an undeclared path degrades instead of throwing', async () => {
    await expect(dbRead.user.findMany({})).resolves.toEqual([]);
    await expect(dbRead.user.findUnique({})).resolves.toBeNull();
    await expect(dbRead.user.count({})).resolves.toBe(0);
    await expect(dbRead.$queryRaw`select 1`).resolves.toEqual([]);
    await expect(dbWrite.$executeRaw`update x`).resolves.toBe(0);
    await expect(redis.get('k')).resolves.toBeNull();
    await expect(sysRedis.hGetAll('k')).resolves.toEqual({});
  });

  it('runs the $transaction callback against the same client', async () => {
    // Returning undefined here would make every transactional path a silent no-op — a
    // test that passes because nothing ran.
    const seen = await dbWrite.$transaction(async (tx: typeof dbWrite) => {
      await tx.image.update({ where: { id: 1 } });
      return 'done';
    });
    expect(seen).toBe('done');
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(dbMock.dbRead.image.update).not.toHaveBeenCalled();
  });

  it('lets a declared behaviour override the default', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: 'declared' });
    await expect(dbRead.keyValue.findUnique({})).resolves.toEqual({ value: 'declared' });
  });

  it('reports call counts scoped to this file', () => {
    // The companion file (2-shared-mocks-isolation.test.ts) drives the same nodes. If the
    // per-file reset regressed, this count would include its calls under --no-isolate.
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(1);
  });
});
