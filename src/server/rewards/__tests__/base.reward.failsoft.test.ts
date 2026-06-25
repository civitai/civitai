import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// Production incident 2026-06-18: a ClickHouse Cloud brownout ("Too many
// simultaneous queries for all users") made the buzz-event REWARD write
// (addBuzzEvent → clickhouse.insert) fail. Because the inline `apply` path runs
// synchronously inside user mutations (user.toggleFollow, post.update,
// collection.saveItem, buzz.claimDailyBoostReward, ...) and previously RETHREW on
// failure, the CH brownout 500'd those user actions.
//
// A non-critical analytics/reward tracking write must NEVER take down a user
// action *when the failure is a transient CH infra brownout*. This suite pins the
// fail-soft contract on the INLINE `apply` path:
//   (a) a TRANSIENT CH error (socket hang up) from addBuzzEvent inside `apply` does
//       NOT propagate (the surrounding user mutation would succeed)
//   (b) the rewardFailedCounter + clickhouseFailSoftCounter increment on that failure
//   (c) no double-award: when the audit insert fails, sendAward is NOT called
//       (the actual Buzz grant is skipped, not duplicated)
//   (d) a sendAward failure inside `apply` ALSO does not propagate (and no rethrow)
//   (e) the batch `process` path STILL rethrows (background cron — unchanged)
//   (f) NARROWING: a NON-transport CH error (UNKNOWN_TABLE / a real query bug) from
//       addBuzzEvent RETHROWS — it must surface as a 500 so a schema break / missing
//       table can't be silently swallowed (the 2026-06-24 missing-table incident).
//
// MONEY-CORRECTNESS (verified from code, documented in PR body): the ClickHouse
// `buzzEvents` insert from addBuzzEvent is an AUDIT row and does not move money.
// The grant is `sendAward` (createBuzzTransactionMany → POST /transactions), which
// runs AFTER addBuzzEvent and is idempotent on externalTransactionId. Dedup is the
// Redis Lua script in processOnDemand, which commits the dedup entry BEFORE
// addBuzzEvent — so skipping the award on failure loses one credit but never
// double-awards.
// ---------------------------------------------------------------------------

// --- Hoisted mock handles (constructed before the vi.mock factories run) -----
const h = vi.hoisted(() => {
  return {
    insertImpl: vi.fn(async () => {}),
    evalImpl: vi.fn(async () => 0 as number),
    hGetImpl: vi.fn(async () => '{}'),
    createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
    getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
    rewardFailedInc: vi.fn(),
    rewardGivenInc: vi.fn(),
    chFailSoftInc: vi.fn(),
    logToAxiom: vi.fn(async () => {}),
  };
});

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: any[]) => h.insertImpl(...args),
    // `process` path uses ch.$query / ch.query for caps; not exercised here.
    $query: vi.fn(async () => []),
    query: vi.fn(async () => ({ json: async () => [] })),
  },
}));

vi.mock('~/server/redis/client', () => ({
  redis: {
    eval: (...args: any[]) => h.evalImpl(...args),
    hGet: (...args: any[]) => h.hGetImpl(...args),
  },
  REDIS_KEYS: { BUZZ_EVENTS: 'buzz-events' },
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: {},
  dbRead: {},
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: any[]) => h.logToAxiom(...args),
}));

vi.mock('~/server/prom/client', () => ({
  rewardFailedCounter: { inc: (...a: any[]) => h.rewardFailedInc(...a) },
  rewardGivenCounter: { inc: (...a: any[]) => h.rewardGivenInc(...a) },
  clickhouseFailSoftCounter: { inc: (...a: any[]) => h.chFailSoftInc(...a) },
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: any[]) => h.createBuzzTransactionMany(...args),
  getMultipliersForUser: (...args: any[]) => h.getMultipliersForUser(...args),
}));

vi.mock('~/shared/constants/buzz.constants', () => ({
  TransactionType: { Reward: 'Reward' },
}));

vi.mock('~/utils/string-helpers', () => ({
  hashifyObject: (o: any) => `hash:${JSON.stringify(o)}`,
}));

// Import AFTER mocks are registered.
import { createBuzzEvent } from '~/server/rewards/base.reward';

beforeEach(() => {
  vi.clearAllMocks();
  // default: insert succeeds, eval awards full amount, multiplier 1
  h.insertImpl.mockResolvedValue(undefined as any);
  h.evalImpl.mockResolvedValue(100 as any);
  h.hGetImpl.mockResolvedValue('{}');
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
});

function makeOnDemandReward() {
  return createBuzzEvent<{ userId: number; entityId: number }>({
    type: 'testReward',
    description: 'Test reward',
    awardAmount: 100,
    cap: 1000,
    onDemand: true,
    getKey: async (input) => ({
      toUserId: input.userId,
      forId: input.entityId,
      byUserId: input.userId,
    }),
  });
}

describe('base.reward inline apply() fail-soft (CH brownout)', () => {
  it('(a) does NOT propagate a TRANSIENT CH insert error out of apply()', async () => {
    // socket hang up = the canonical CH Cloud transport flap (the 2026-06-24 issue).
    h.insertImpl.mockRejectedValue(new Error('socket hang up'));
    const reward = makeOnDemandReward();

    // Must resolve (not reject) — the surrounding user mutation would succeed.
    await expect(reward.apply({ userId: 1, entityId: 42 })).resolves.toBeUndefined();
  });

  it('(a2) also fail-softs the transient CAPACITY brownout (Code 202)', async () => {
    h.insertImpl.mockRejectedValue(new Error('Too many simultaneous queries for all users'));
    const reward = makeOnDemandReward();
    await expect(reward.apply({ userId: 1, entityId: 42 })).resolves.toBeUndefined();
    expect(h.chFailSoftInc).toHaveBeenCalledWith({ path: 'buzz-reward' });
  });

  it('(b) increments rewardFailedCounter + clickhouseFailSoftCounter on a transient failure', async () => {
    h.insertImpl.mockRejectedValue(new Error('socket hang up'));
    const reward = makeOnDemandReward();

    await reward.apply({ userId: 1, entityId: 42 });

    expect(h.rewardFailedInc).toHaveBeenCalledTimes(1);
    expect(h.chFailSoftInc).toHaveBeenCalledWith({ path: 'buzz-reward' });
  });

  it('(c) does NOT send the award (no double-award) when the audit insert fails transiently', async () => {
    h.evalImpl.mockResolvedValue(100); // would be an "awarded" event
    h.insertImpl.mockRejectedValue(new Error('socket hang up'));
    const reward = makeOnDemandReward();

    await reward.apply({ userId: 1, entityId: 42 });

    // The grant (createBuzzTransactionMany) must not run when we couldn't record
    // the audit row — skip, don't grant, don't 500.
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(h.rewardGivenInc).not.toHaveBeenCalled();
  });

  it('(c2) limits inline insert retries (does not block ~2.5s with 5 retries)', async () => {
    h.insertImpl.mockRejectedValue(new Error('socket hang up'));
    const reward = makeOnDemandReward();

    await reward.apply({ userId: 1, entityId: 42 });

    // INLINE_RETRY_COUNT = 1 → 2 total attempts. (Batch path uses 5 → 6 attempts.)
    expect(h.insertImpl).toHaveBeenCalledTimes(2);
  });

  it('(f) RETHROWS a non-transport CH error (UNKNOWN_TABLE) so a schema break surfaces', async () => {
    // Code 60 UNKNOWN_TABLE — the missing-table deploy break. Must NOT be swallowed.
    const tableError = Object.assign(new Error('Table default.buzzEvents does not exist'), {
      code: '60',
    });
    h.insertImpl.mockRejectedValue(tableError);
    const reward = makeOnDemandReward();

    await expect(reward.apply({ userId: 1, entityId: 42 })).rejects.toThrow(/does not exist/);
    // Fail-soft counter must NOT increment — this isn't a transient brownout.
    expect(h.chFailSoftInc).not.toHaveBeenCalled();
    // The award is never sent (we threw before reaching sendAward).
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('happy path: records the event and sends the award', async () => {
    h.evalImpl.mockResolvedValue(100);
    const reward = makeOnDemandReward();

    await reward.apply({ userId: 1, entityId: 42 });

    expect(h.insertImpl).toHaveBeenCalledTimes(1);
    expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    expect(h.rewardGivenInc).toHaveBeenCalledTimes(1);
    expect(h.rewardFailedInc).not.toHaveBeenCalled();
  });

  it('(d) does NOT propagate a sendAward failure out of apply()', async () => {
    h.evalImpl.mockResolvedValue(100); // awarded
    h.insertImpl.mockResolvedValue(undefined as any); // audit row written
    h.createBuzzTransactionMany.mockRejectedValue(new Error('buzz API 500'));
    const reward = makeOnDemandReward();

    await expect(reward.apply({ userId: 1, entityId: 42 })).resolves.toBeUndefined();
    expect(h.rewardFailedInc).toHaveBeenCalledTimes(1);
    expect(h.rewardGivenInc).not.toHaveBeenCalled();
  });

  it('capped event does not call sendAward (unchanged)', async () => {
    h.evalImpl.mockResolvedValue(0); // 0 = capped
    const reward = makeOnDemandReward();

    await reward.apply({ userId: 1, entityId: 42 });

    expect(h.insertImpl).toHaveBeenCalledTimes(1);
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

describe('base.reward batch process() still rethrows (cron path unchanged)', () => {
  function makeProcessableReward() {
    return createBuzzEvent<{ userId: number; entityId: number }>({
      type: 'testProcessable',
      description: 'Test processable reward',
      awardAmount: 100,
      getKey: async (input) => ({
        toUserId: input.userId,
        forId: input.entityId,
        byUserId: input.userId,
      }),
    });
  }

  it('(e) rethrows on update failure in the batch process path', async () => {
    h.insertImpl.mockRejectedValue(new Error('CH down'));
    const reward = makeProcessableReward();

    const ctx = {
      toProcess: [
        {
          type: 'testProcessable',
          toUserId: 1,
          forId: 42,
          byUserId: 1,
          awardAmount: 100,
          status: 'pending' as const,
        },
      ],
      lastUpdate: new Date(),
      ch: {} as any,
      db: {} as any,
    };

    await expect(reward.process(ctx)).rejects.toThrow(/Buzz Event Processing Failure/);
  });
});
