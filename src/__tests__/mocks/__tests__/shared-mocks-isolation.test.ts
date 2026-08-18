import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The companion to shared-mocks.test.ts. Both files drive the SAME canonical nodes, which
 * under `--no-isolate` are the same objects in the same worker.
 *
 * Every assertion here is order-independent on purpose: which file runs first depends on
 * sharding, and a cross-file assertion that only holds in one order is the exact class of
 * test this project keeps tripping over. What is invariant is that a file starts clean.
 */
describe('shared-module mocks: per-file reset', () => {
  it('starts with no inherited call history', () => {
    expect(dbMock.dbRead.keyValue.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });

  it('starts with no inherited ASSIGNED data property', async () => {
    // shared-mocks.test.ts sets `sysRedis.isReady = false`. That is not mock state, so
    // `mockReset()` does not touch it — without the node tracking assignments separately it
    // would land on the underlying `vi.fn` and outlive the file that set it for the whole
    // worker.
    // An unset property vivifies to a node by design, so the invariant is not "undefined" —
    // it is that the previous file's VALUE is gone.
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    expect((redisMock.sysRedis as unknown as { isReady?: boolean }).isReady).not.toBe(false);
  });

  it('starts with no inherited implementation', async () => {
    // shared-mocks.test.ts sets `{ value: 'declared' }` on this exact node. Seeing that
    // value here would mean the reset ran once per worker instead of once per file.
    await expect(dbMock.dbRead.keyValue.findUnique({})).resolves.toBeNull();
  });

  it('drives the shared nodes, so the companion file can prove the same thing', async () => {
    await dbMock.dbRead.keyValue.findUnique({});
    await dbMock.dbWrite.image.update({ where: { id: 2 } });
    expect(dbMock.dbRead.keyValue.findUnique).toHaveBeenCalledTimes(2);
  });
});
