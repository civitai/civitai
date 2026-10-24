import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  acquireBlockPollHoldSlot,
  BLOCK_POLL_HOLD_SLOT_TTL_MS,
} from '~/server/utils/block-poll-hold-slots';

const redis = redisMock.redis;
const KEY = 'blocks:token-rate-limit:poll-hold:inst_7:42';
const LIMIT = 3;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  redis.zRemRangeByScore.mockReset().mockResolvedValue(0);
  redis.zAdd.mockReset().mockResolvedValue(1);
  redis.expire.mockReset().mockResolvedValue(true);
  redis.zCard.mockReset().mockResolvedValue(1);
  redis.zRem.mockReset().mockResolvedValue(1);
});

function addedMember(): string {
  return (redis.zAdd.mock.calls[0][1] as { value: string }).value;
}

describe('acquireBlockPollHoldSlot', () => {
  it('grants a slot at the limit, keyed per (install, viewer), with a self-expiring entry', async () => {
    redis.zCard.mockResolvedValue(LIMIT);

    const release = await acquireBlockPollHoldSlot('inst_7', 42, LIMIT);

    expect(release).toBeTypeOf('function');
    expect(redis.zRemRangeByScore).toHaveBeenCalledWith(KEY, '-inf', 1_000_000);
    expect(redis.zAdd).toHaveBeenCalledWith(KEY, {
      score: 1_000_000 + BLOCK_POLL_HOLD_SLOT_TTL_MS,
      value: expect.any(String),
    });
    expect(redis.expire).toHaveBeenCalledWith(KEY, 25);
    expect(redis.zRem).not.toHaveBeenCalled();
  });

  it('release removes exactly the entry it added', async () => {
    const release = await acquireBlockPollHoldSlot('inst_7', 42, LIMIT);
    await release!();
    expect(redis.zRem.mock.calls).toEqual([[KEY, addedMember()]]);
  });

  it('refuses a slot over the limit and takes its own entry back out', async () => {
    redis.zCard.mockResolvedValue(LIMIT + 1);

    await expect(acquireBlockPollHoldSlot('inst_7', 42, LIMIT)).resolves.toBeNull();
    expect(redis.zRem.mock.calls).toEqual([[KEY, addedMember()]]);
  });

  it.each([
    ['zAdd throws', () => redis.zAdd.mockRejectedValue(new Error('down'))],
    ['zCard throws', () => redis.zCard.mockRejectedValue(new Error('down'))],
    ['zCard answers a non-number', () => redis.zCard.mockResolvedValue(undefined)],
  ])('fails open to NO hold when %s', async (_label, arrange) => {
    arrange();
    await expect(acquireBlockPollHoldSlot('inst_7', 42, LIMIT)).resolves.toBeNull();
  });

  it('a release that cannot reach the store does not throw', async () => {
    redis.zRem.mockRejectedValue(new Error('down'));
    const release = await acquireBlockPollHoldSlot('inst_7', 42, LIMIT);
    await expect(release!()).resolves.toBeUndefined();
  });
});
