import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ delIfValue: vi.fn(async () => true) }));
vi.mock('~/server/redis/atomic', () => ({ delIfValue: mocks.delIfValue }));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  acquireOutputUnlockLock,
  outputUnlockLockKey,
} from '~/server/services/blocks/block-output-unlock-lock';
import { OUTPUT_UNLOCK_LOCK_TTL_SECONDS } from '~/server/services/blocks/block-output-unlock.service';

const sysRedis = redisMock.sysRedis;
const WF = '42-20261115120000000';

beforeEach(() => {
  sysRedis.set.mockReset();
  sysRedis.get.mockReset();
  sysRedis.del.mockReset();
  mocks.delIfValue.mockClear();
});

describe('the per-workflow output unlock lock', () => {
  it('is SET NX with the TTL, keyed on the workflow', async () => {
    sysRedis.set.mockResolvedValue('OK');
    const release = await acquireOutputUnlockLock(WF);
    expect(release).toBeTypeOf('function');
    expect(sysRedis.set).toHaveBeenCalledWith(outputUnlockLockKey(WF), expect.any(String), {
      NX: true,
      EX: OUTPUT_UNLOCK_LOCK_TTL_SECONDS,
    });
    expect(outputUnlockLockKey(WF)).toBe(`system:blocks:output-unlock-lock:${WF}`);
  });

  it('a second acquire while held returns null', async () => {
    sysRedis.set.mockResolvedValue(null);
    expect(await acquireOutputUnlockLock(WF)).toBeNull();
  });

  it('🔴 release is an atomic compare-and-delete on THIS holder token, never a plain DEL', async () => {
    sysRedis.set.mockResolvedValue('OK');
    const release = await acquireOutputUnlockLock(WF);
    const owner = sysRedis.set.mock.calls[0][1];
    await release!();
    expect(mocks.delIfValue).toHaveBeenCalledTimes(1);
    expect(mocks.delIfValue).toHaveBeenCalledWith(sysRedis, outputUnlockLockKey(WF), owner);
    // Not a read-then-delete, which a lapse between the two could turn into deleting another
    // holder's lock.
    expect(sysRedis.del).not.toHaveBeenCalled();
    expect(sysRedis.get).not.toHaveBeenCalled();
  });

  it('a release that fails leaves the lock to its TTL and does not throw', async () => {
    sysRedis.set.mockResolvedValue('OK');
    const release = await acquireOutputUnlockLock(WF);
    mocks.delIfValue.mockRejectedValueOnce(new Error('redis down'));
    await expect(release!()).resolves.toBeUndefined();
  });
});
