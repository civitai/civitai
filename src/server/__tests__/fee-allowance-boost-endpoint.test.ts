import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

const cohort = vi.hoisted(() => ({
  bankers: [] as number[],
  flagged: [] as number[],
  validMembers: new Set<number>(),
  excluded: new Set<number>(),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: async () => cohort.bankers.map((userId) => ({ userId: String(userId) })) },
}));
vi.mock('~/server/services/creator-membership.service', () => ({
  getValidCreatorMembershipMap: async (ids: number[]) =>
    new Map(ids.map((id) => [id, cohort.validMembers.has(id)])),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
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
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (strings.join('?').includes('ANY('))
      return (values[0] as number[]).filter((id) => !cohort.excluded.has(id)).map((id) => ({ id }));
    return cohort.flagged.map((id) => ({ id }));
  }) as never);
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

describe('fee-allowance-boost grant-eligible', () => {
  beforeEach(() => {
    cohort.bankers = [1, 2];
    cohort.flagged = [2, 3, 4];
    cohort.validMembers = new Set([2, 3]);
    cohort.excluded = new Set();
    redisMock.sysRedis.hSetNX.mockResolvedValue(true);
  });

  it('counts recent bankers plus members with a valid membership, once each', async () => {
    const res = await call({ action: 'grant-eligible', dryRun: true });

    expect(res.json).toHaveBeenCalledWith({ dryRun: true, bankers: 2, members: 2, eligible: 3 });
    expect(redisMock.sysRedis.hSetNX).not.toHaveBeenCalled();
  });

  it('grants exactly that cohort', async () => {
    await call({ action: 'grant-eligible' });

    const granted = redisMock.sysRedis.hSetNX.mock.calls.map((c) => c[1]).sort();
    expect(granted).toEqual(['1', '2', '3']);
  });

  it('skips banned or deleted accounts on either list', async () => {
    cohort.excluded = new Set([1, 3]);

    const res = await call({ action: 'grant-eligible', dryRun: true });

    expect(res.json).toHaveBeenCalledWith({ dryRun: true, bankers: 1, members: 1, eligible: 1 });
    const standing = dbMock.dbRead.$queryRaw.mock.calls
      .map((c) => (c[0] as TemplateStringsArray).join('?'))
      .find((sql) => sql.includes('ANY('));
    expect(standing).toMatch(
      /onboarding & \? = 0\s+AND "bannedAt" IS NULL\s+AND "deletedAt" IS NULL/
    );
  });

  it('writes a large list in bounded chunks', async () => {
    cohort.bankers = Array.from({ length: 600 }, (_, i) => i + 1);
    let inFlight = 0;
    let peak = 0;
    redisMock.sysRedis.hSetNX.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return true;
    });

    await call({ action: 'grant-eligible' });

    expect(redisMock.sysRedis.hSetNX).toHaveBeenCalledTimes(600);
    expect(peak).toBe(250);
  });
});
