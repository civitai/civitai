import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `buzzEvents.forId` is Int32 and the app inserts with `async_insert=1,
// wait_for_async_insert=0`. A reward whose key carries a string forId therefore
// produces a row ClickHouse drops server-side while the HTTP insert returns
// success — the Buzz is still paid and no error reaches the app. 4M
// generation-feedback payouts wrote zero event rows this way (ClickUp 868ktbnjh),
// and 92,729 `ParsingError` batches in a 2-day window were the only trace.
//
// These tests assert on what is handed to `clickhouse.insert`, not on a helper
// in isolation, because the defect was in what reached the wire.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  insertImpl: vi.fn(async () => undefined),
  queryImpl: vi.fn(async () => [] as unknown[]),
  evalImpl: vi.fn(async () => 0 as number),
  hGetImpl: vi.fn(async () => '{}'),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: any[]) => h.insertImpl(...args),
    $query: (...args: any[]) => h.queryImpl(...args),
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

import { createBuzzEvent } from '~/server/rewards/base.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.eval.mockImplementation((...args: any[]) => h.evalImpl(...args));
redisMock.redis.hGet.mockImplementation((...args: any[]) => h.hGetImpl(...args));

const AWARD_AMOUNT = 4;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  h.insertImpl.mockResolvedValue(undefined as any);
  h.evalImpl.mockResolvedValue(AWARD_AMOUNT as any);
  h.hGetImpl.mockResolvedValue('{}');
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
});

const stringKeyReward = () =>
  createBuzzEvent<{ userId: number; jobId: string }>({
    type: 'testStringForId',
    description: 'Test reward keyed on a string',
    awardAmount: AWARD_AMOUNT,
    cap: 40,
    onDemand: true,
    getKey: async (input) => ({
      toUserId: input.userId,
      forId: input.jobId,
      byUserId: input.userId,
    }),
  });

const insertedRow = () => {
  const call = h.insertImpl.mock.calls.find((args: any[]) => args[0]?.table === 'buzzEvents') as
    | any[]
    | undefined;
  if (!call) throw new Error('no buzzEvents insert was attempted');
  return call[0].values[0];
};

describe('buzzEvents columns narrower than BuzzEventLog', () => {
  it('clamps a multiplier past the Decimal(3, 2) ceiling instead of losing the row', async () => {
    // gold's 4 times MAX_GLOBAL_BONUS of 5 is 20, against a column that stops at 9.99.
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 20 });
    h.evalImpl.mockResolvedValue(80 as any);

    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

    const row = insertedRow();
    expect(row.multiplier).toBe(9.99);
    expect(JSON.parse(row.transactionDetails)).toMatchObject({ multiplierRaw: 20 });
  });

  it('leaves a multiplier the column can hold alone', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 4 });
    h.evalImpl.mockResolvedValue(16 as any);

    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

    expect(insertedRow().multiplier).toBe(4);
  });

  // The ceiling above and the floor below are separate guards: `Math.max` does not bound a value
  // from above and a `> ceiling` test does not bound one from below. A negative reaches here from
  // one operator-typed `Product.metadata.rewardsMultiplier`, which the cache reads as a bare float.
  it('floors a negative multiplier at 0 rather than recording the negative', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: -1 });
    h.evalImpl.mockResolvedValue(-4 as any);

    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

    const row = insertedRow();
    // 0 is the value `process-rewards` already reads as unqualified: no payout, and the reporter's
    // cap is left intact. A negative kept as a negative passes the ceiling check, is recorded
    // `awarded`, eats the cap, and is then dropped by `sendAward`'s amount filter.
    expect(row.multiplier).toBe(0);
    expect(JSON.parse(row.transactionDetails)).toMatchObject({ multiplierRaw: -1 });
  });

  // `Math.max(0, NaN)` is `NaN`, so a floor alone does not cover this: Decimal(3, 2) cannot hold
  // NaN, and the insert runs `wait_for_async_insert=0`, so the row is dropped server-side with the
  // Buzz already paid — the same silent loss the ceiling exists to prevent.
  it.each([
    ['NaN', NaN, 1],
    ['Infinity', Infinity, 1],
    ['-Infinity', -Infinity, 0],
  ] as const)(
    'replaces a %s multiplier with a value the column can hold',
    async (label, raw, expected) => {
      h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: raw });
      h.evalImpl.mockResolvedValue(raw as any);

      await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

      const row = insertedRow();
      expect(row.multiplier).toBe(expected);
      // Recorded as a string: `JSON.stringify` writes all three as `null`, which is
      // indistinguishable from the raw having been absent.
      expect(JSON.parse(row.transactionDetails)).toMatchObject({ multiplierRaw: label });
    }
  );

  // `Number.isFinite` does not coerce where the `> ceiling` test it replaced did, so a multiplier
  // read back out of the ClickHouse `Decimal(3, 2)` as a quoted string would take the non-finite
  // fallback. That is an underpay, not a dropped row: `sendAward` pays `awardAmount * multiplier`.
  it('leaves a quoted in-range multiplier alone rather than reading it as non-finite', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: '4.00' } as any);
    h.evalImpl.mockResolvedValue(16 as any);

    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

    const row = insertedRow();
    expect(row.multiplier).toBe('4.00');
    expect(JSON.parse(row.transactionDetails)).not.toHaveProperty('multiplierRaw');
  });

  // The raw is recorded from the ORIGINAL value, not from its coercion: `String(Number('4x'))` is
  // `'NaN'`, which loses the only thing that would tell an operator which product is misconfigured.
  it('records the original text when the multiplier is not a number at all', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: '4x' } as any);
    h.evalImpl.mockResolvedValue(NaN as any);

    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

    const row = insertedRow();
    expect(row.multiplier).toBe(1);
    expect(JSON.parse(row.transactionDetails)).toMatchObject({ multiplierRaw: '4x' });
  });

  it('clamps a quoted multiplier past the ceiling and records the raw as a number', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: '20.00' } as any);
    h.evalImpl.mockResolvedValue(80 as any);

    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

    const row = insertedRow();
    expect(row.multiplier).toBe(9.99);
    expect(JSON.parse(row.transactionDetails)).toMatchObject({ multiplierRaw: 20 });
  });
});

describe('buzzEvents forId must be an Int32 by the time it reaches ClickHouse', () => {
  it('inserts a number for a non-numeric key, so the row is not silently dropped', async () => {
    await stringKeyReward().apply({ userId: 7, jobId: 'S34PXN0E7NNXGPBWM2G883Z0F0.jpeg' });

    const row = insertedRow();
    expect(typeof row.forId).toBe('number');
    expect(Number.isInteger(row.forId)).toBe(true);
    expect(Math.abs(row.forId)).toBeLessThanOrEqual(2147483647);
  });

  it('keeps the original key so a dropped row can still be traced back', async () => {
    await stringKeyReward().apply({ userId: 7, jobId: 'S34PXN0E7NNXGPBWM2G883Z0F0.jpeg' });

    expect(JSON.parse(insertedRow().transactionDetails)).toMatchObject({
      forIdRaw: 'S34PXN0E7NNXGPBWM2G883Z0F0.jpeg',
    });
  });

  it('is stable, so the same key always lands on the same id', async () => {
    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });
    const first = insertedRow().forId;

    h.insertImpl.mockClear();
    await stringKeyReward().apply({ userId: 8, jobId: 'job-abc' });

    expect(insertedRow().forId).toBe(first);
  });

  it('reads a numeric key as that number rather than hashing it', async () => {
    await stringKeyReward().apply({ userId: 7, jobId: '12345' });

    expect(insertedRow().forId).toBe(12345);
  });

  it('leaves the money path alone — the transaction still keys on the raw value', async () => {
    await stringKeyReward().apply({ userId: 7, jobId: 'job-abc' });

    const [transactions] = h.createBuzzTransactionMany.mock.calls[0] as any[];
    expect(transactions[0].externalTransactionId).toBe('testStringForId:job-abc-7-7');
    expect(transactions[0].details.forId).toBe('job-abc');
  });

  it('reads a whitespace-padded key as a hash, not as the same number', async () => {
    // buzzEvents is ORDER BY (type, toUserId, forId, byUserId) on a ReplacingMergeTree, so two
    // distinct keys collapsing to one id replace each other instead of both landing.
    await stringKeyReward().apply({ userId: 7, jobId: ' 42 ' });
    const padded = insertedRow().forId;

    h.insertImpl.mockClear();
    await stringKeyReward().apply({ userId: 7, jobId: '42' });

    expect(padded).not.toBe(insertedRow().forId);
  });

  it('hashes a numeric string past the Int32 ceiling instead of sending it', async () => {
    // Deleting the range check leaves every fixture in this suite green, because they are all
    // short. An orchestrator job id or a snowflake is not.
    await stringKeyReward().apply({ userId: 7, jobId: '9999999999' });

    const row = insertedRow();
    expect(Math.abs(row.forId)).toBeLessThanOrEqual(2147483647);
    expect(row.forId).not.toBe(9999999999);
    expect(JSON.parse(row.transactionDetails)).toMatchObject({ forIdRaw: '9999999999' });
  });

  it('hashes a NUMBER past the Int32 ceiling, which short-circuited the whole function', async () => {
    const bigNumericReward = createBuzzEvent<{ userId: number; entityId: number }>({
      type: 'testOversizeNumericForId',
      description: 'Test reward keyed on an oversize number',
      awardAmount: AWARD_AMOUNT,
      cap: 40,
      onDemand: true,
      getKey: async (input) => ({
        toUserId: input.userId,
        forId: input.entityId,
        byUserId: input.userId,
      }),
    });

    await bigNumericReward.apply({ userId: 7, entityId: 9999999999 });

    const row = insertedRow();
    expect(Math.abs(row.forId)).toBeLessThanOrEqual(2147483647);
    expect(JSON.parse(row.transactionDetails)).toMatchObject({ forIdRaw: 9999999999 });
  });

  it('preserves the reward payload alongside the coerced value', async () => {
    // Every other fixture here starts from '{}', so replacing `{ ...details, ...coerced }` with
    // `coerced` alone stays green. goodContent, collectedContent and imagePostedToModel all define
    // getTransactionDetails and all reach the coerced path.
    const detailedReward = createBuzzEvent<{ userId: number; jobId: string }>({
      type: 'testDetailsReward',
      description: 'Test reward carrying transaction details',
      awardAmount: AWARD_AMOUNT,
      cap: 40,
      onDemand: true,
      getKey: async (input) => ({
        toUserId: input.userId,
        forId: input.jobId,
        byUserId: input.userId,
      }),
      getTransactionDetails: async () => ({ modelVersionId: 991, note: 'keep me' }),
    });

    await detailedReward.apply({ userId: 7, jobId: 'job-abc' });

    expect(JSON.parse(insertedRow().transactionDetails)).toMatchObject({
      modelVersionId: 991,
      note: 'keep me',
      forIdRaw: 'job-abc',
    });
  });

  it('leaves a numeric forId untouched', async () => {
    const numericReward = createBuzzEvent<{ userId: number; entityId: number }>({
      type: 'testNumericForId',
      description: 'Test reward keyed on a number',
      awardAmount: AWARD_AMOUNT,
      cap: 40,
      onDemand: true,
      getKey: async (input) => ({
        toUserId: input.userId,
        forId: input.entityId,
        byUserId: input.userId,
      }),
    });

    await numericReward.apply({ userId: 7, entityId: 991 });

    const row = insertedRow();
    expect(row.forId).toBe(991);
    expect(row.transactionDetails).toBe('{}');
  });
});
