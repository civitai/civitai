import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeDynamicPool } from '../challenge-pool';
import { CHALLENGE_JOB_BATCH_SIZE } from '~/shared/constants/challenge.constants';

// challenge-helpers.ts (transitively, via daily-challenge.utils.ts) eagerly constructs real
// db/redis clients at import time. Mock them so the module graph loads without a live DB/Redis.
const { mockDbRead, mockDbWrite, mockRedis } = vi.hoisted(() => {
  const dbRead = { $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) };
  const dbWrite = {
    challenge: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const redis = {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    scanIterator: async function* () {},
  };
  return { mockDbRead: dbRead, mockDbWrite: dbWrite, mockRedis: redis };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: { sMembers: vi.fn(async () => []) },
  REDIS_KEYS: { DAILY_CHALLENGE: { DETAILS: 'daily-challenge:details' } },
  REDIS_SYS_KEYS: {},
  withSysReadDeadline: vi.fn(async (fn: () => unknown) => fn()),
}));

describe('computeDynamicPool', () => {
  const defaultDistribution = [50, 30, 20];

  it('returns base pool when there are zero entries', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 0,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(2500);
    expect(result.prizes).toEqual([
      { buzz: 1250, points: 150 },
      { buzz: 750, points: 100 },
      { buzz: 500, points: 50 },
    ]);
  });

  it('grows pool by buzzPerAction * actionCount', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 100,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    // 2500 + 5*100 = 3000
    expect(result.totalPool).toBe(3000);
    expect(result.prizes[0].buzz).toBe(1500); // 50% of 3000
    expect(result.prizes[1].buzz).toBe(900); // 30% of 3000
    expect(result.prizes[2].buzz).toBe(600); // 20% of 3000
  });

  it('clamps pool at maxPrizePool', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 10000,
      maxPrizePool: 10000,
      prizeDistribution: defaultDistribution,
    });

    // 2500 + 5*10000 = 52500, capped at 10000
    expect(result.totalPool).toBe(10000);
    expect(result.prizes[0].buzz).toBe(5000);
    expect(result.prizes[1].buzz).toBe(3000);
    expect(result.prizes[2].buzz).toBe(2000);
  });

  it('does not clamp when pool is below max', () => {
    const result = computeDynamicPool({
      basePrizePool: 2500,
      buzzPerAction: 5,
      actionCount: 10,
      maxPrizePool: 10000,
      prizeDistribution: defaultDistribution,
    });

    // 2500 + 5*10 = 2550, below 10000
    expect(result.totalPool).toBe(2550);
  });

  it('does not clamp when pool exactly equals max', () => {
    const result = computeDynamicPool({
      basePrizePool: 0,
      buzzPerAction: 100,
      actionCount: 100,
      maxPrizePool: 10000,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(10000);
  });

  it('assigns rounding remainder to 1st place', () => {
    // 100 with 33/33/34 distribution:
    // floor(100*33/100) = 33, floor(100*33/100) = 33, floor(100*34/100) = 34 → allocated = 100
    // But try a case that actually rounds: 1000 with 33/33/34
    // floor(10000*33/100) = 3300, floor(10000*33/100) = 3300, floor(10000*34/100) = 3400 → 10000, no remainder

    // Use a pool that causes rounding: 10 with 33/33/34
    // floor(10*33/100) = 3, floor(10*33/100) = 3, floor(10*34/100) = 3 → allocated = 9, remainder = 1
    const result = computeDynamicPool({
      basePrizePool: 10,
      buzzPerAction: 0,
      actionCount: 0,
      maxPrizePool: null,
      prizeDistribution: [33, 33, 34],
    });

    expect(result.totalPool).toBe(10);
    expect(result.prizes[0].buzz).toBe(4); // 3 + 1 remainder
    expect(result.prizes[1].buzz).toBe(3);
    expect(result.prizes[2].buzz).toBe(3);
    // Verify total allocated equals pool
    expect(result.prizes.reduce((sum, p) => sum + p.buzz, 0)).toBe(10);
  });

  it('handles zero base pool with growth', () => {
    const result = computeDynamicPool({
      basePrizePool: 0,
      buzzPerAction: 10,
      actionCount: 50,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(500);
    expect(result.prizes[0].buzz).toBe(250);
    expect(result.prizes[1].buzz).toBe(150);
    expect(result.prizes[2].buzz).toBe(100);
  });

  it('handles zero buzzPerAction (base only, no growth)', () => {
    const result = computeDynamicPool({
      basePrizePool: 5000,
      buzzPerAction: 0,
      actionCount: 9999,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.totalPool).toBe(5000);
  });

  it('assigns default points by place', () => {
    const result = computeDynamicPool({
      basePrizePool: 1000,
      buzzPerAction: 0,
      actionCount: 0,
      maxPrizePool: null,
      prizeDistribution: defaultDistribution,
    });

    expect(result.prizes[0].points).toBe(150);
    expect(result.prizes[1].points).toBe(100);
    expect(result.prizes[2].points).toBe(50);
  });

  it('total allocated buzz always equals totalPool', () => {
    // Test with several awkward distributions that cause rounding
    const cases = [
      { pool: 7, dist: [33, 33, 34] },
      { pool: 1, dist: [50, 30, 20] },
      { pool: 13, dist: [40, 35, 25] },
      { pool: 9999, dist: [33, 33, 34] },
      { pool: 0, dist: [50, 30, 20] },
    ];

    for (const { pool, dist } of cases) {
      const result = computeDynamicPool({
        basePrizePool: pool,
        buzzPerAction: 0,
        actionCount: 0,
        maxPrizePool: null,
        prizeDistribution: dist,
      });

      const totalAllocated = result.prizes.reduce((sum, p) => sum + p.buzz, 0);
      expect(totalAllocated).toBe(result.totalPool);
    }
  });
});

describe('getChallengesByIds', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([]);
  });

  it('is exported and returns an array', async () => {
    const { getChallengesByIds } = await import('../challenge-helpers');
    expect(typeof getChallengesByIds).toBe('function');
  });

  it('returns empty array for empty input without hitting the db', async () => {
    const { getChallengesByIds } = await import('../challenge-helpers');
    await expect(getChallengesByIds([])).resolves.toEqual([]);
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('issues exactly one query for multiple ids (kills the N+1)', async () => {
    const { getChallengesByIds } = await import('../challenge-helpers');
    await getChallengesByIds([1, 2, 3]);
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('bounded job selectors', () => {
  // Selectors that hydrate ids via getChallengesByIds — each issues an id-listing query
  // (call 1) then, if any ids came back, a single batched hydrate query (call 2). The old
  // Promise.all(rows.map(getChallengeById)) pattern would have issued 1 + N queries instead.
  const hydratingSelectors: Array<[string, () => Promise<unknown>]> = [
    [
      'getActiveChallengesFromDb',
      async () => (await import('../challenge-helpers')).getActiveChallengesFromDb(),
    ],
    [
      'getEndedActiveChallengesFromDb',
      async () => (await import('../challenge-helpers')).getEndedActiveChallengesFromDb(),
    ],
    [
      'getChallengesToReconcileFromDb',
      async () => (await import('../challenge-helpers')).getChallengesToReconcileFromDb(),
    ],
    [
      'getScheduledChallengesReadyToStart',
      async () => (await import('../challenge-helpers')).getScheduledChallengesReadyToStart(),
    ],
  ];

  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
  });

  it('CHALLENGE_JOB_BATCH_SIZE exceeds the old hardcoded 50-row cap (regression guard)', () => {
    // getActiveChallengesFromDb used to hardcode LIMIT 50, silently dropping the 51st+ active
    // challenge. If this constant ever regresses back to <=50 that bug returns.
    expect(CHALLENGE_JOB_BATCH_SIZE).toBeGreaterThan(50);
  });

  it.each(hydratingSelectors)(
    '%s: hydrates 60 ids via ONE batched query, not N+1',
    async (_name, run) => {
      const idRows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1 }));
      mockDbRead.$queryRaw
        .mockResolvedValueOnce(idRows) // id-listing query
        .mockResolvedValueOnce([]); // getChallengesByIds batched hydrate query

      await run();

      expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(2);
    }
  );

  it.each(hydratingSelectors)(
    '%s: bounds the id-listing query at CHALLENGE_JOB_BATCH_SIZE with a stable ORDER BY',
    async (_name, run) => {
      mockDbRead.$queryRaw.mockResolvedValue([]); // empty id list short-circuits getChallengesByIds

      await run();

      expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[]
      ];
      const sql = strings.join('?');
      expect(sql).toMatch(/ORDER BY .*ASC.*,\s*(?:c\.)?id ASC/);
      expect(sql).toMatch(/LIMIT \?/);
      expect(values).toContain(CHALLENGE_JOB_BATCH_SIZE);
      expect(values).not.toContain(50);
    }
  );

  it('getUnscannedUserChallengesPastStart: bounds at CHALLENGE_JOB_BATCH_SIZE with a stable ORDER BY (no hydrate query)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    const { getUnscannedUserChallengesPastStart } = await import('../challenge-helpers');

    await getUnscannedUserChallengesPastStart();

    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mockDbRead.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?');
    expect(sql).toMatch(/ORDER BY "startsAt" ASC, id ASC/);
    expect(sql).toMatch(/LIMIT \?/);
    expect(values).toContain(CHALLENGE_JOB_BATCH_SIZE);
    expect(values).not.toContain(50);
  });
});

describe('setChallengeActive idempotency', () => {
  beforeEach(() => {
    mockDbWrite.challenge.updateMany.mockReset();
    mockDbRead.$queryRaw.mockReset();
    mockDbRead.$queryRaw.mockResolvedValue([]);
    mockRedis.packed.set.mockClear();
  });

  it('activates only from Scheduled and is a no-op on second call', async () => {
    // First tick wins the conditional write; a concurrent/second tick finds status is no
    // longer 'Scheduled' and updateMany matches zero rows.
    mockDbWrite.challenge.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const { setChallengeActive } = await import('../challenge-helpers');

    const first = await setChallengeActive(1);
    expect(first).toEqual({ activated: true });
    expect(mockDbWrite.challenge.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 1, status: 'Scheduled' },
      data: { status: 'Active' },
    });
    // Side effect (Redis cache write) only runs when this call actually activated it.
    expect(mockRedis.packed.set).toHaveBeenCalledTimes(1);

    const second = await setChallengeActive(1);
    expect(second).toEqual({ activated: false });
    expect(mockDbWrite.challenge.updateMany).toHaveBeenCalledTimes(2);
    // No duplicate side effect on the no-op second call.
    expect(mockRedis.packed.set).toHaveBeenCalledTimes(1);
  });
});
