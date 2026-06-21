import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// appBlockReview reward (F-E "marketplace" cluster) — blue-buzz for leaving a
// review. Money-touching, so we pin:
//   - fires ONCE on the create branch (isFirstReview=true): blue account,
//     forId = appBlockId (per-(user,app) dedup), correct user.
//   - does NOT fire on an update (isFirstReview=false → getKey returns false →
//     no Redis dedup write, no audit insert, no award).
//   - fail-soft: a ClickHouse insert throw inside apply() does NOT propagate
//     (the surrounding review write must still succeed).
//   - already-awarded (Redis dedup returns -1) → no award, no throw.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  insertImpl: vi.fn(async () => {}),
  evalImpl: vi.fn(async () => 25 as number),
  hGetImpl: vi.fn(async () => '{}'),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
  rewardFailedInc: vi.fn(),
  rewardGivenInc: vi.fn(),
  logToAxiom: vi.fn(async () => {}),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: any[]) => h.insertImpl(...args),
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

vi.mock('~/server/db/client', () => ({ dbWrite: {}, dbRead: {} }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: any[]) => h.logToAxiom(...args),
}));
vi.mock('~/server/prom/client', () => ({
  rewardFailedCounter: { inc: (...a: any[]) => h.rewardFailedInc(...a) },
  rewardGivenCounter: { inc: (...a: any[]) => h.rewardGivenInc(...a) },
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

// Import AFTER mocks.
import { appBlockReviewReward } from '~/server/rewards/active/appBlockReview.reward';

beforeEach(() => {
  vi.clearAllMocks();
  h.insertImpl.mockResolvedValue(undefined as any);
  h.evalImpl.mockResolvedValue(25 as any); // award full amount by default
  h.hGetImpl.mockResolvedValue('{}');
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
});

describe('appBlockReviewReward', () => {
  it('fires once on the create branch: blue account, forId=appBlockId, correct user', async () => {
    await appBlockReviewReward.apply(
      { appBlockId: 'ab_42', userId: 7, isFirstReview: true },
      { ip: '1.2.3.4' }
    );

    // Audit row recorded with the right key.
    expect(h.insertImpl).toHaveBeenCalledTimes(1);
    const inserted = h.insertImpl.mock.calls[0][0] as { values: any[] };
    expect(inserted.values[0]).toMatchObject({
      type: 'appBlockReview',
      toUserId: 7,
      byUserId: 7,
      forId: 'ab_42',
    });

    // Award granted to the BLUE account.
    expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    const txs = h.createBuzzTransactionMany.mock.calls[0][0] as any[];
    expect(txs[0]).toMatchObject({ toAccountId: 7, toAccountType: 'blue' });
    // Dedup anchor in the external transaction id is the appBlockId.
    expect(txs[0].externalTransactionId).toContain('appBlockReview:ab_42');
    expect(h.rewardGivenInc).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on an update (isFirstReview=false → no key, no award, no insert)', async () => {
    await appBlockReviewReward.apply(
      { appBlockId: 'ab_42', userId: 7, isFirstReview: false },
      { ip: '1.2.3.4' }
    );

    // getKey returned false → apply short-circuits before any side effect.
    expect(h.evalImpl).not.toHaveBeenCalled();
    expect(h.insertImpl).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('fail-soft: a ClickHouse insert throw does NOT propagate (review write survives)', async () => {
    h.insertImpl.mockRejectedValue(new Error('Too many simultaneous queries for all users'));

    await expect(
      appBlockReviewReward.apply({ appBlockId: 'ab_42', userId: 7, isFirstReview: true })
    ).resolves.toBeUndefined();

    // No grant when the audit insert failed (no double-award), failure counted.
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(h.rewardFailedInc).toHaveBeenCalledTimes(1);
  });

  it('already-awarded (Redis dedup returns -1) → no award, no throw', async () => {
    h.evalImpl.mockResolvedValue(-1); // dedup hit
    await expect(
      appBlockReviewReward.apply({ appBlockId: 'ab_42', userId: 7, isFirstReview: true })
    ).resolves.toBeUndefined();

    expect(h.insertImpl).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});
