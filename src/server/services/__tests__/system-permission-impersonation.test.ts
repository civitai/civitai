import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { removeSystemPermission } from '~/server/services/system-cache';

// The real cut, not the global stub, so the key it writes is what is checked.
vi.unmock('~/server/auth/session-invalidation');

const MOD = 100;
const USER_CUT = REDIS_SYS_KEYS.SESSION.USER_CUT;
const keysSet = () => redisMock.sysRedis.set.mock.calls.map(([key]) => String(key));

beforeEach(() => {
  redisMock.sysRedis.set.mockClear();
  redisMock.sysRedis.get.mockResolvedValue(
    JSON.stringify({ impersonation: [MOD, 101], creatorsProgram: [MOD] })
  );
});

describe('removing a system permission', () => {
  it("ends that moderator's impersonations when the impersonation grant goes, not their own sessions", async () => {
    await removeSystemPermission('impersonation', MOD);
    expect(keysSet()).toContain(`${USER_CUT}:impersonator:${MOD}`);
    expect(keysSet()).not.toContain(`${USER_CUT}:${MOD}`);
    expect(keysSet()).not.toContain(`${USER_CUT}:impersonator:101`);
  });

  it('ends no impersonation when another permission goes', async () => {
    await removeSystemPermission('creatorsProgram', MOD);
    expect(keysSet().filter((key) => key.startsWith(USER_CUT))).toEqual([]);
  });
});
