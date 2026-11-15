import { beforeEach, describe, expect, it } from 'vitest';
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

  it('release deletes the key while it still holds this caller token', async () => {
    sysRedis.set.mockResolvedValue('OK');
    const release = await acquireOutputUnlockLock(WF);
    const owner = sysRedis.set.mock.calls[0][1];
    sysRedis.get.mockResolvedValue(owner);
    await release!();
    expect(sysRedis.del).toHaveBeenCalledWith(outputUnlockLockKey(WF));
  });

  it('release after the lock lapsed and was re-taken leaves the new holder alone', async () => {
    sysRedis.set.mockResolvedValue('OK');
    const release = await acquireOutputUnlockLock(WF);
    sysRedis.get.mockResolvedValue('someone-else');
    await release!();
    expect(sysRedis.del).not.toHaveBeenCalled();
  });
});
