import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The multiplier reaching the AWARD computation, not the ClickHouse audit row.
//
// `rewardsMultiplier` is read off operator-authored `Product.metadata`, and has THREE readers:
// `processOnDemand` (which stringifies it into the Redis Lua cap script), `sendAward` (which pays
// `awardAmount * multiplier`), and `getUserRewardDetails` (which advertises the award and cap).
// `toClickhouseBuzzEvent`'s clamp reaches none of them — it clamps a copy on its way to ClickHouse
// and leaves the event alone.
//
// These mock `getMultipliersForUser`. The real one floors its BASE and then multiplies by the
// bonus without re-clamping the product, so it can hand these sites a non-finite value built from
// two finite floored factors — pinned by `can return a NON-FINITE multiplier` in
// buzz.service.multiplier-floor.test.ts. That is what the clamps here cover.
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
    //
    // 🔴 `evalImpl` returning exactly AWARD_AMOUNT is load-bearing. `effectiveAward` is also 100, so
    // `toAward < effectiveAward` is false and `apply` does NOT take the cap-trim branch that
    // neutralises `event.multiplier` to 1. Lower this mock and the test passes vacuously with the
    // clamp gone. The assertion below pins the equality rather than trusting the default.
    await applyWith(NaN);

    expect(luaArgs().award, 'the cap-trim branch would neutralise the multiplier').toBe(
      String(AWARD_AMOUNT)
    );
    expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    const [transactions] = h.createBuzzTransactionMany.mock.calls[0] as unknown as [
      { amount: number }[]
    ];
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount).toBe(100);
  });

  it('pays a quoted multiplier at its value, not at the non-finite fallback', async () => {
    // 🔴 The batch path reads `multiplier` back out of a ClickHouse `Decimal(3, 2)`, where it is
    // `number`-typed and string-valued. `Number.isFinite('4.00')` is FALSE, so a clamp that tests
    // the argument directly pays 1x for a legitimate 4x — the underpay `toClickhouseBuzzEvent` was
    // already fixed for once (f450100aba), reached through a different reader. Do not "simplify"
    // the `Number()` out of `clampRewardMultiplier`.
    // The Lua returns the FULL effective award, so the grant is untrimmed and `apply` leaves
    // `event.multiplier` alone — the branch where `sendAward` reads the quoted value. At the
    // default mock return of 100 the cap-trim branch neutralises it to 1 and the test cannot see
    // the bug at all.
    h.evalImpl.mockResolvedValue(400 as any);
    await applyWith('4.00' as unknown as number);

    // Asserted, not assumed: if the cap-trim branch is ever taken, `event.multiplier` is
    // neutralised to 1 and the assertion below stops seeing the clamp at all. The sibling above
    // pins the same precondition for the same reason.
    expect(luaArgs().award, 'the cap-trim branch would neutralise the multiplier').toBe('400');

    const [transactions] = h.createBuzzTransactionMany.mock.calls[0] as unknown as [
      { amount: number }[]
    ];
    expect(transactions[0].amount).toBe(400);
  });
});

describe('the multiplier the rewards list advertises', () => {
  it('is a number, not Infinity', async () => {
    // The third reader. Display rather than money, so it was the one with no test — and a clamp
    // with no test is what the rest of this file exists to argue against.
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: Infinity } as any);

    const details = await reward().getUserRewardDetails(1);

    expect(details?.awardAmount).toBe(AWARD_AMOUNT);
    expect(details?.cap).toBe(CAP);
  });

  it('still applies a legitimate multiplier', async () => {
    // Negative control: without it the assertions above pass on an implementation that ignores the
    // multiplier entirely.
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 4 } as any);

    const details = await reward().getUserRewardDetails(1);

    expect(details?.awardAmount).toBe(AWARD_AMOUNT * 4);
    expect(details?.cap).toBe(CAP * 4);
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

  it('reads a quoted decimal at its value', () => {
    // The unit-level statement of the batch-path bug. Without this, the coercion is reachable only
    // through the three-mock integration test above.
    expect(clampRewardMultiplier('4.00' as unknown as number)).toBe(4);
    expect(clampRewardMultiplier('0.00' as unknown as number)).toBe(0);
  });

  it('agrees with clampBuzzEventMultiplier on the half they do share', () => {
    // `multiplier.ts` claims its non-finite rule matches the shared helper's. Only the ceiling was
    // pinned, so the claim could rot in either direction without a test noticing.
    //
    // Numbers only, deliberately: on a quoted decimal the two DISAGREE and are meant to —
    // `clampRewardMultiplier('4.00')` is 4 and `clampBuzzEventMultiplier('4.00')` is 1, because the
    // shared helper's callers coerce for it. Pinned in the test above, not folded in here.
    const values = [-5, -Infinity, NaN, Infinity, 0, 0.5, 4];
    expect(values).toHaveLength(7);
    for (const value of values) {
      expect(clampRewardMultiplier(value), `disagreed on ${String(value)}`).toBe(
        clampBuzzEventMultiplier(value)
      );
    }
  });

  it('does not bound a large finite multiplier — only a ceiling would, and that is a product call', () => {
    expect(clampRewardMultiplier(1e20)).toBe(1e20);
  });
});
