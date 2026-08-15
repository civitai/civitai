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

  it('exposes withSysReadDeadline as a seam whose default is the REAL deadline', async () => {
    const redisClient = await import('~/server/redis/client');
    expect(redisClient.withSysReadDeadline).toBe(redisMock.withSysReadDeadline);

    // The default has to still time out, or promoting it to a seam would silently disarm a
    // live guard in every file in the worker. A hanging promise is the only input that tells
    // the real implementation apart from a pass-through — every resolved promise looks the
    // same through both.
    await expect(redisClient.withSysReadDeadline(new Promise(() => undefined), 5)).rejects.toThrow(
      'sysRedis read timed out after 5ms'
    );

    // …and the positive control for that assertion: the same call resolves when the promise
    // beats the deadline. Without this, a seam that rejected everything would also pass.
    await expect(redisClient.withSysReadDeadline(Promise.resolve('v'), 5000)).resolves.toBe('v');

    // The lever the nine blocked files need: replace it per file, and the reset restores the
    // real implementation for the next one.
    redisMock.withSysReadDeadline.mockRejectedValueOnce(new Error('injected'));
    await expect(redisClient.withSysReadDeadline(Promise.resolve('v'))).rejects.toThrow('injected');
  });

  it('never evaluates the real db/redis shims, so no client is ever constructed', () => {
    // 🔴 The registration spreads the PACKAGE, not `importOriginal` of the app shim. The
    // shims construct Prisma/Redis clients at module scope, so spreading them forced real
    // construction into EVERY test file — and a file whose own `@prisma/client` mock lacks a
    // `PrismaClient` constructor then died at module scope, collecting ZERO tests while the
    // failure count stayed at 0. Both shims stash their clients on globalThis outside prod,
    // so an absent global is direct evidence the module body never ran.
    const g = globalThis as { __civitaiPrismaClients?: unknown; __civitaiRedisClients?: unknown };
    expect(g.__civitaiPrismaClients).toBeUndefined();
    expect(g.__civitaiRedisClients).toBeUndefined();
  });

  it('tracks an assigned data property and reads it back', () => {
    // Production code reads flags off these clients (`sysRedis.isReady`), and tests set them.
    // The companion file asserts this does not survive into the next file.
    (redisMock.sysRedis as unknown as { isReady?: boolean }).isReady = false;
    expect((redisMock.sysRedis as unknown as { isReady?: boolean }).isReady).toBe(false);
    expect((sysRedis as unknown as { isReady?: boolean }).isReady).toBe(false);
  });

  it('is never mistaken for a thenable', async () => {
    // A node resolving `then` to a child would make it callable by the await machinery,
    // which hangs rather than fails.
    expect((dbMock.dbRead as unknown as { then: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(dbMock.dbRead)).resolves.toBe(dbMock.dbRead);
  });

  it('applies read-shaped defaults so an undeclared path degrades instead of throwing', async () => {
    // Called through the canonical nodes rather than the re-exported Prisma/Redis types.
    // They are the same objects (asserted above); the typed surfaces demand real
    // `where`/key arguments, which would make this a test about argument shapes.
    await expect(dbMock.dbRead.user.findMany({})).resolves.toEqual([]);
    await expect(dbMock.dbRead.user.findUnique({})).resolves.toBeNull();
    await expect(dbMock.dbRead.user.count({})).resolves.toBe(0);
    await expect(dbMock.dbRead.$queryRaw`select 1`).resolves.toEqual([]);
    await expect(dbMock.dbWrite.$executeRaw`update x`).resolves.toBe(0);
    await expect(redisMock.redis.get('k')).resolves.toBeNull();
    await expect(redisMock.sysRedis.hGetAll('k')).resolves.toEqual({});
  });

  it('runs the $transaction callback against the same client', async () => {
    // Returning undefined here would make every transactional path a silent no-op — a
    // test that passes because nothing ran.
    const seen = await dbMock.dbWrite.$transaction(async (tx: typeof dbMock.dbWrite) => {
      await tx.image.update({ where: { id: 1 } });
      return 'done';
    });
    expect(seen).toBe('done');
    expect(dbMock.dbWrite.image.update).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(dbMock.dbRead.image.update).not.toHaveBeenCalled();
  });

  it('lets a declared behaviour override the default', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: 'declared' });
    await expect(dbMock.dbRead.keyValue.findUnique({})).resolves.toEqual({ value: 'declared' });
  });

  it('reports call counts scoped to this file', () => {
    // The companion file (2-shared-mocks-isolation.test.ts) drives the same nodes. If the
    // per-file reset regressed, this count would include its calls under --no-isolate.
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(1);
  });
});
