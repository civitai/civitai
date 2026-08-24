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
