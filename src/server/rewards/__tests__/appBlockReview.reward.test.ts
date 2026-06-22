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
  // GA ACTIVATION: the reward is surfaced on the Buzz dashboard at launch
  // (user.controller.ts filters the reward list by `.visible`). It was `false`
  // while App Blocks was dark/mod-gated (PR #2675); this pins the GA flip so an
  // accidental revert to hidden is caught.
  it('is visible on the Buzz dashboard (GA activation)', () => {
    expect(appBlockReviewReward.visible).toBe(true);
  });

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

  // -------------------------------------------------------------------------
  // DAILY-CEILING (FIX 1): the cap is a per-UTC-day TOTAL across all apps, NOT a
  // per-app cap. We prove the two belts that make this safe without
  // re-implementing the Lua:
  //   - distinct apps reviewed by the SAME user the SAME day produce DISTINCT
  //     Redis cacheKeys (ARGV[2]) → they don't dedup against each other, so each
  //     pays (the prior cap=25-per-day-total bug would have capped the 2nd to 0;
  //     here the cap passed to Redis is the higher ceiling, ARGV[4]=250).
  //   - the SAME app same-day produces the SAME cacheKey → the Redis dedup
  //     (eval returns -1) suppresses the 2nd award, AND an update branch
  //     (isFirstReview=false) never even reaches eval.
  // -------------------------------------------------------------------------
  describe('FIX 1: per-distinct-app reward, daily ceiling (not per-app cap)', () => {
    const cacheKeyOf = (call: any[]) => call[1].arguments[1] as string; // ARGV[2]
    const capOf = (call: any[]) => call[1].arguments[3] as string; // ARGV[4]

    it('two DIFFERENT apps, same user, same day → distinct cacheKeys (each can pay) + cap is the higher ceiling (250)', async () => {
      await appBlockReviewReward.apply(
        { appBlockId: 'ab_1', userId: 7, isFirstReview: true },
        { ip: '1.2.3.4' }
      );
      await appBlockReviewReward.apply(
        { appBlockId: 'ab_2', userId: 7, isFirstReview: true },
        { ip: '1.2.3.4' }
      );

      expect(h.evalImpl).toHaveBeenCalledTimes(2);
      const k1 = cacheKeyOf(h.evalImpl.mock.calls[0]);
      const k2 = cacheKeyOf(h.evalImpl.mock.calls[1]);
      // Distinct apps → distinct dedup cacheKeys → NOT mutually capped at the
      // first review. (forId = appBlockId is baked into the key.)
      expect(k1).not.toEqual(k2);
      expect(k1).toContain('ab_1');
      expect(k2).toContain('ab_2');

      // The cap handed to the Lua is the DAILY CEILING (25 * 10 = 250), NOT 25 —
      // so the 2nd distinct app isn't capped to 0 the way cap=25 would.
      expect(capOf(h.evalImpl.mock.calls[0])).toBe('250');
      expect(capOf(h.evalImpl.mock.calls[1])).toBe('250');

      // Both first-reviews granted (eval returns the full award by default).
      expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(2);
      const tx1 = h.createBuzzTransactionMany.mock.calls[0][0] as any[];
      const tx2 = h.createBuzzTransactionMany.mock.calls[1][0] as any[];
      expect(tx1[0].externalTransactionId).toContain('appBlockReview:ab_1');
      expect(tx2[0].externalTransactionId).toContain('appBlockReview:ab_2');
    });

    it('SAME app reviewed twice the same day → SAME cacheKey → Redis dedup suppresses the 2nd award (no double-pay)', async () => {
      // 1st create: full award.
      await appBlockReviewReward.apply(
        { appBlockId: 'ab_1', userId: 7, isFirstReview: true },
        { ip: '1.2.3.4' }
      );
      // 2nd same-app same-day attempt: the Lua would HGET the existing entry and
      // return -1 (already awarded). Model that.
      h.evalImpl.mockResolvedValueOnce(-1 as any);
      await appBlockReviewReward.apply(
        { appBlockId: 'ab_1', userId: 7, isFirstReview: true },
        { ip: '1.2.3.4' }
      );

      // Same forId → identical cacheKey across both attempts.
      const k1 = cacheKeyOf(h.evalImpl.mock.calls[0]);
      const k2 = cacheKeyOf(h.evalImpl.mock.calls[1]);
      expect(k1).toEqual(k2);

      // Only the FIRST attempt granted Buzz; the dedup (-1) suppressed the 2nd.
      expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    });

    it('SAME app, an UPDATE (isFirstReview=false) never reaches Redis → no reward', async () => {
      await appBlockReviewReward.apply(
        { appBlockId: 'ab_1', userId: 7, isFirstReview: false },
        { ip: '1.2.3.4' }
      );
      // getKey returns false on the update branch → short-circuit before eval.
      expect(h.evalImpl).not.toHaveBeenCalled();
      expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
    });
  });
});
