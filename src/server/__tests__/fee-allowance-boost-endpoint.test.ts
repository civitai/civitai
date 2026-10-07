import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

import handler from '~/pages/api/testing/fee-allowance-boost';

const KEY = REDIS_SYS_KEYS.PRICING.FEE_ALLOWANCE_BOOST;

function call(body: unknown) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return (handler as (req: unknown, res: unknown) => Promise<unknown>)(
    { method: 'POST', body },
    res
  ).then(() => res);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  redisMock.sysRedis.hSetNX.mockReset();
  redisMock.sysRedis.expireAt.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('fee-allowance-boost grant', () => {
  it('adds only new grants, never overwriting an existing amount', async () => {
    redisMock.sysRedis.hSetNX.mockImplementation(
      async (_key: string, field: string) => field !== '2'
    );

    const res = await call({ action: 'grant', userIds: [1, 2, 2, 3], amount: 40 });

    expect(redisMock.sysRedis.hSetNX).toHaveBeenCalledTimes(3);
    expect(redisMock.sysRedis.hSetNX).toHaveBeenCalledWith(KEY, '1', '40');
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ granted: 2, alreadyGranted: 1, amount: 40 })
    );
  });

  it('expires the key at the end of the window', async () => {
    redisMock.sysRedis.hSetNX.mockResolvedValue(true);
    await call({ action: 'grant', userIds: [1] });
    expect(redisMock.sysRedis.expireAt).toHaveBeenCalledWith(
      KEY,
      new Date('2026-11-01T00:00:00.000Z')
    );
  });

  it('refuses an amount above the maximum', async () => {
    const res = await call({ action: 'grant', userIds: [1], amount: 101 });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(redisMock.sysRedis.hSetNX).not.toHaveBeenCalled();
  });

  it('refuses to grant once the window has closed', async () => {
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const res = await call({ action: 'grant', userIds: [1] });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(redisMock.sysRedis.hSetNX).not.toHaveBeenCalled();
  });
});
