import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `foldUserMultipliers` sets `rewardsMultiplier` to 0 for a user whose
// `rewardsEligibility` is `Ineligible`. `sendAward` used to turn that 0 back
// into 1 — a line from 2024 that predates the eligibility flag and read the 0
// as a missing value — so an ineligible user was paid the FULL award. Measured
// on the prod replica 2026-08-25: 548 `awarded` rows carrying `multiplier = 0`
// in 7 days, across 24 users, and all 24 were `Ineligible`; the ledger shows
// 470 blue-Buzz transactions worth 3,052 Buzz behind them.
//
// The bug lives on the PROCESSABLE path only: an on-demand reward multiplies
// before the Lua cap script, so a 0 multiplier already produced a `capped` row
// that never reached `sendAward`. A suite built on an on-demand reward
// therefore passes with the defect fully present.
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
import type { BuzzEventLog } from '~/server/rewards/base.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.eval.mockImplementation((...args: any[]) => h.evalImpl(...args));
redisMock.redis.hGet.mockImplementation((...args: any[]) => h.hGetImpl(...args));

const AWARD_AMOUNT = 100;
const CAP = 1000;
const INELIGIBLE_USER = 1;
const ELIGIBLE_USER = 2;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  h.insertImpl.mockResolvedValue(undefined as any);
  h.queryImpl.mockResolvedValue([]);
  h.evalImpl.mockResolvedValue(AWARD_AMOUNT as any);
  h.hGetImpl.mockResolvedValue('{}');
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
});

const processableReward = () =>
  createBuzzEvent<{ userId: number; entityId: number }>({
    type: 'testIneligibleReward',
    description: 'Test processable reward',
    awardAmount: AWARD_AMOUNT,
    caps: [{ keyParts: ['toUserId'], interval: 'day', amount: CAP }],
    getKey: async (input) => ({
      toUserId: input.userId,
      forId: input.entityId,
      byUserId: input.userId,
    }),
  });

const pending = (toUserId: number, multiplier: number, forId: number): BuzzEventLog => ({
  type: 'testIneligibleReward',
  toUserId,
  forId,
  byUserId: toUserId,
  awardAmount: AWARD_AMOUNT,
  multiplier,
  status: 'pending',
});

const processCtx = (toProcess: BuzzEventLog[]) =>
  ({ toProcess, lastUpdate: new Date(0), ch: {}, db: {} } as any);

/** Every transaction handed to `createBuzzTransactionMany`, flattened across calls. */
const sentTransactions = () =>
  h.createBuzzTransactionMany.mock.calls.flatMap((args: any[]) => args[0] ?? []);

/** The rows handed to ClickHouse for the `buzzEvents` table, flattened across inserts. */
const insertedRows = () =>
  h.insertImpl.mock.calls
    .filter((args: any[]) => args[0]?.table === 'buzzEvents')
    .flatMap((args: any[]) => args[0].values ?? []);

describe('process() does not pay a rewards-ineligible user', () => {
  it('sends no transaction for a pending row whose multiplier is 0', async () => {
    await processableReward().process(
      processCtx([pending(INELIGIBLE_USER, 0, 10), pending(INELIGIBLE_USER, 0, 11)])
    );

    // Assert on the transactions themselves, not on a call count: `sendAward` is invoked
    // per chunk regardless, and an empty array reaching it is the intended shape.
    expect(sentTransactions()).toEqual([]);
  });

  it('still pays an eligible user in the same batch', async () => {
    // The positive control for the assertion above — without this, `sentTransactions()`
    // returning [] would also pass for a harness that never sends anything at all.
    await processableReward().process(
      processCtx([pending(INELIGIBLE_USER, 0, 10), pending(ELIGIBLE_USER, 1, 11)])
    );

    const sent = sentTransactions();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ toAccountId: ELIGIBLE_USER, amount: AWARD_AMOUNT });
  });

  it('applies a multiplier above 1 rather than treating every multiplier as pass-through', async () => {
    // Pins that the fix reads the stored multiplier instead of discarding it.
    await processableReward().process(processCtx([pending(ELIGIBLE_USER, 2.5, 11)]));

    expect(sentTransactions()[0]).toMatchObject({
      toAccountId: ELIGIBLE_USER,
      amount: Math.ceil(AWARD_AMOUNT * 2.5),
    });
  });

  it('records the ineligible row as earning nothing instead of as awarded', async () => {
    await processableReward().process(processCtx([pending(INELIGIBLE_USER, 0, 10)]));

    const rows = insertedRows();
    expect(rows).toHaveLength(1);
    // `unqualified` is outside the ClickHouse Enum8, so `toClickhouseBuzzEvent` coerces it to
    // `capped`; either spelling means "seen, paid nothing" and neither means `awarded`.
    expect(rows[0]).toMatchObject({ toUserId: INELIGIBLE_USER, status: 'capped', awardAmount: 0 });
  });
});

describe('apply() stores the ineligibility decision on the pending row', () => {
  it('writes multiplier 0 rather than 1, and sends nothing inline', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 0 });

    await processableReward().apply({ userId: INELIGIBLE_USER, entityId: 10 });

    const rows = insertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toUserId: INELIGIBLE_USER,
      multiplier: 0,
      status: 'pending',
    });
    expect(sentTransactions()).toEqual([]);
  });
});
