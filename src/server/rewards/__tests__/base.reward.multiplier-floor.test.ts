import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The multiplier reaching the AWARD computation, not the ClickHouse audit row.
//
// `rewardsMultiplier` is read off operator-authored `Product.metadata`, and lands in TWO money
// computations: `processOnDemand` (which stringifies it into the Redis Lua cap script) and
// `sendAward` (which pays `awardAmount * multiplier`). `toClickhouseBuzzEvent`'s clamp reaches
// neither — it clamps a copy on its way to ClickHouse, so the event keeps the raw value and the
// audit row can record it.
//
// The assertions below read the ARGV strings the Lua actually receives and the amount
// `createBuzzTransactionMany` is actually asked for, because those are the two values that decide
// whether a mutation throws and what a user is paid.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  insertImpl: vi.fn(async () => undefined),
  evalImpl: vi.fn(async () => 0 as number),
  hGetImpl: vi.fn(async () => '{}'),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: any[]) => h.insertImpl(...args),
    $query: vi.fn(async () => []),
    query: vi.fn(async () => ({ json: async () => [] })),
  },
}));

vi.mock('~/server/prom/client', () => ({
  rewardFailedCounter: { inc: vi.fn() },
  rewardGivenCounter: { inc: vi.fn() },
  clickhouseFailSoftCounter: { inc: vi.fn() },
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: any[]) => h.createBuzzTransactionMany(...args),
  getMultipliersForUser: (...args: any[]) => h.getMultipliersForUser(...args),
}));

import { BUZZ_EVENTS_MAX_MULTIPLIER, clampBuzzEventMultiplier } from '@civitai/clickhouse';
import { createBuzzEvent } from '~/server/rewards/base.reward';
import { clampRewardMultiplier } from '~/server/rewards/multiplier';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.eval.mockImplementation((...args: any[]) => h.evalImpl(...args));
redisMock.redis.hGet.mockImplementation((...args: any[]) => h.hGetImpl(...args));

const AWARD_AMOUNT = 100;
const CAP = 1000;

const reward = () =>
  createBuzzEvent<{ userId: number; entityId: number }>({
    type: 'testMultiplierFloorReward',
    description: 'Test on-demand reward',
    awardAmount: AWARD_AMOUNT,
    cap: CAP,
    onDemand: true,
    getKey: async (input) => ({
      toUserId: input.userId,
      forId: input.entityId,
      byUserId: input.userId,
    }),
  });

/** ARGV[3] and ARGV[4]: the effective award and the effective cap, as the Lua receives them. */
const luaArgs = () => {
  const args = (h.evalImpl.mock.calls[0]?.[1] as { arguments: string[] } | undefined)?.arguments;
  if (!args) throw new Error('redis.eval was never called — the reward never reached the script');
  return { award: args[2], cap: args[3] };
};

const applyWith = async (rewardsMultiplier: number) => {
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier } as any);
  await reward().apply({ userId: 1, entityId: 10 }, {});
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  h.insertImpl.mockResolvedValue(undefined as any);
  h.hGetImpl.mockResolvedValue('{}');
  h.evalImpl.mockResolvedValue(AWARD_AMOUNT as any);
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
});

describe('the multiplier handed to the Lua cap script', () => {
  it('is a number Lua can parse when the multiplier is Infinity', async () => {
    await applyWith(Infinity);

    const { award, cap } = luaArgs();
    // `tonumber('Infinity')` is nil in Lua, and the arithmetic on nil throws out of `redis.eval`
    // and into the user's mutation. Asserting the STRING is the point: it is what crosses the wire.
    expect(award).toBe('100');
    expect(cap).toBe('1000');
    expect(Number.isFinite(Number(award))).toBe(true);
    expect(Number.isFinite(Number(cap))).toBe(true);
  });

  it('is a number Lua can parse when the multiplier is NaN', async () => {
    await applyWith(NaN);

    const { award, cap } = luaArgs();
    expect(award).toBe('100');
    expect(cap).toBe('1000');
  });

  it('is floored at zero when the multiplier is negative', async () => {
    await applyWith(-2);

    const { award, cap } = luaArgs();
    // A negative award is written into the dedup entry as `a:-200`, which the reader's
    // `'^a:(%d+)$'` cannot match, so every later read of that entry falls back to the CURRENT
    // award for the rest of the day. Cap accounting, not just an ugly row.
    expect(award).toBe('0');
    expect(cap).toBe('0');
  });

  it('leaves a legitimate multiplier alone', async () => {
    await applyWith(4);

    expect(luaArgs()).toEqual({ award: '400', cap: '4000' });
  });
});

describe('the multiplier sendAward pays from', () => {
  it('is floored too, not only the one the cap script sees', async () => {
    // `sendAward` is a SECOND money computation reading the same value, and flooring
    // `processOnDemand` alone leaves it raw. `toClickhouseBuzzEvent` does not cover it: that clamps
    // a copy on its way to ClickHouse and deliberately leaves the event alone, so the audit row can
    // record `multiplierRaw`.
    //
    // NaN is what makes the difference legible: `Math.ceil(100 * NaN)` is NaN, `NaN > 0` is false,
    // and `sendAward`'s own amount filter then drops the transaction entirely — the user is
    // recorded `awarded` and paid nothing.
    await applyWith(NaN);

    const [transactions] = h.createBuzzTransactionMany.mock.calls[0] as unknown as [
      { amount: number }[]
    ];
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount).toBe(100);
  });
});

describe('clampRewardMultiplier', () => {
  it('floors at 0 and keeps a zero, which is how rewards-ineligibility is reported', () => {
    expect(clampRewardMultiplier(-5)).toBe(0);
    expect(clampRewardMultiplier(0)).toBe(0);
  });

  it('falls back by sign for a non-finite value', () => {
    expect(clampRewardMultiplier(Infinity)).toBe(1);
    expect(clampRewardMultiplier(-Infinity)).toBe(0);
    expect(clampRewardMultiplier(NaN)).toBe(1);
  });

  it('keeps a sub-1 multiplier, which is a priced product and not a defect', () => {
    expect(clampRewardMultiplier(0.5)).toBe(0.5);
  });

  // 🔴 THE DECISION THIS FILE EXISTS TO PIN. If you are here because you replaced
  // `clampRewardMultiplier` with `clampBuzzEventMultiplier` to remove a near-duplicate: don't. The
  // shared helper carries the `buzzEvents.multiplier` column's 9.99 ceiling, which is right for a
  // ClickHouse audit row and wrong here, because `sendAward` PAYS `awardAmount * multiplier`. Gold's
  // 4 times a MAX_GLOBAL_BONUS of 5 is a legitimate 20, and capping it at 9.99 halves the payout of
  // a bonus event nobody asked to change. Delete this test and that becomes invisible.
  it('keeps no ceiling, unlike clampBuzzEventMultiplier', () => {
    expect(clampBuzzEventMultiplier(20)).toBe(BUZZ_EVENTS_MAX_MULTIPLIER);
    expect(clampRewardMultiplier(20)).toBe(20);
  });

  it('does not bound a large finite multiplier — only a ceiling would, and that is a product call', () => {
    expect(clampRewardMultiplier(1e20)).toBe(1e20);
  });
});
