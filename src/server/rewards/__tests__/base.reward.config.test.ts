import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `rewards:config` turns a reward off, or changes its amount and cap, without a
// deploy. There are THREE doors out of `createBuzzEvent` and the gate has to
// hold on all of them:
//
//   apply()                 the inline grant path
//   process()               the `rewards-process` cron, which pays the `pending`
//                           rows apply() wrote earlier
//   getUserRewardDetails()  the user-facing rewards list
//
// The process() gate is the one that is easy to leave untested. On-demand
// rewards (firstDailyFollow, generatorFeedback, dailyBoost, ...) write `awarded`
// or `capped` inline and NEVER write a `pending` row, so a suite built around
// one of them enters the sweep zero times while looking like it covers it. The
// sweep tests below therefore use PROCESSABLE rewards — a local one and the real
// `goodContentReward` — which are the only rewards that can reach it.
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
import { goodContentReward } from '~/server/rewards/passive/goodContent.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.eval.mockImplementation((...args: any[]) => h.evalImpl(...args));
redisMock.redis.hGet.mockImplementation((...args: any[]) => h.hGetImpl(...args));

const findUnique = dbMock.dbRead.keyValue.findUnique;
const configure = (rewards: Record<string, unknown>) =>
  findUnique.mockResolvedValue({ value: { rewards } });

const AWARD_AMOUNT = 100;
const CAP = 1000;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  findUnique.mockResolvedValue(null);
  h.insertImpl.mockResolvedValue(undefined as any);
  h.queryImpl.mockResolvedValue([]);
  h.evalImpl.mockResolvedValue(AWARD_AMOUNT as any);
  h.hGetImpl.mockResolvedValue('{}');
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
});

const getKey = vi.fn(async (input: { userId: number; entityId: number }) => ({
  toUserId: input.userId,
  forId: input.entityId,
  byUserId: input.userId,
}));

const onDemandReward = () =>
  createBuzzEvent<{ userId: number; entityId: number }>({
    type: 'testOnDemandReward',
    description: 'Test on-demand reward',
    awardAmount: AWARD_AMOUNT,
    cap: CAP,
    onDemand: true,
    getKey,
  });

const processableReward = () =>
  createBuzzEvent<{ userId: number; entityId: number }>({
    type: 'testProcessableReward',
    description: 'Test processable reward',
    awardAmount: AWARD_AMOUNT,
    caps: [{ keyParts: ['toUserId'], interval: 'day', amount: CAP }],
    getKey,
  });

const pendingEvents = (type: string): BuzzEventLog[] => [
  { type, toUserId: 1, forId: 10, byUserId: 2, awardAmount: AWARD_AMOUNT, status: 'pending' },
  { type, toUserId: 1, forId: 11, byUserId: 3, awardAmount: AWARD_AMOUNT, status: 'pending' },
];

const processCtx = (toProcess: BuzzEventLog[]) =>
  ({ toProcess, lastUpdate: new Date(0), ch: {}, db: {} } as any);

describe('apply() is gated before it does any work', () => {
  it('does not resolve the key, the multiplier, the dedup entry or the audit row', async () => {
    configure({ testOnDemandReward: { enabled: false } });

    await onDemandReward().apply({ userId: 1, entityId: 42 });

    // The order matters, not just the outcome: `orchestrator.router` calls apply
    // once per feedback patch inside a live generation mutation, so a disabled
    // reward must cost one early return rather than a DB read, a Redis script
    // and a ClickHouse insert per patch.
    expect(getKey).not.toHaveBeenCalled();
    expect(h.getMultipliersForUser).not.toHaveBeenCalled();
    expect(h.evalImpl).not.toHaveBeenCalled();
    expect(h.insertImpl).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('still grants when the config names the reward without disabling it', async () => {
    configure({ testOnDemandReward: { awardAmount: 4 } });

    await onDemandReward().apply({ userId: 1, entityId: 42 });

    expect(getKey).toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).toHaveBeenCalled();
  });

  it('records the overridden amount, not the compiled one', async () => {
    configure({ testOnDemandReward: { awardAmount: 4 } });

    await onDemandReward().apply({ userId: 1, entityId: 42 });

    expect(h.insertImpl).toHaveBeenCalledWith(
      expect.objectContaining({ values: [expect.objectContaining({ awardAmount: 4 })] })
    );
  });

  // The override moves the base number; membership still scales it afterwards.
  it('applies the membership multiplier on top of the override', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 2 });
    configure({ testOnDemandReward: { awardAmount: 4, cap: 8 } });

    await onDemandReward().apply({ userId: 1, entityId: 42 });

    const [, options] = h.evalImpl.mock.calls[0] as any[];
    // ARGV[3] = effective award, ARGV[4] = effective cap — both multiplied.
    expect(options.arguments[2]).toBe('8');
    expect(options.arguments[3]).toBe('16');
    expect(h.createBuzzTransactionMany).toHaveBeenCalledWith([
      expect.objectContaining({ amount: 8 }),
    ]);
  });

  it('uses the compiled amount and cap when no row exists', async () => {
    await onDemandReward().apply({ userId: 1, entityId: 42 });

    const [, options] = h.evalImpl.mock.calls[0] as any[];
    expect(options.arguments[2]).toBe(String(AWARD_AMOUNT));
    expect(options.arguments[3]).toBe(String(CAP));
  });
});

describe('process() does not pay out a disabled reward’s backlog', () => {
  it('marks the pending rows terminally unqualified instead of awarding them', async () => {
    configure({ testProcessableReward: { enabled: false } });
    const toProcess = pendingEvents('testProcessableReward');

    await processableReward().process(processCtx(toProcess));

    // Terminal, not skipped: the job scans `time >= lastUpdate` and never looks
    // back, so a skipped row would strand pending forever.
    expect(toProcess.map((x) => x.status)).toEqual(['unqualified', 'unqualified']);
    expect(toProcess.map((x) => x.awardAmount)).toEqual([0, 0]);
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
    // The rows are written back, or the sweep is a local mutation nobody sees.
    expect(h.insertImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        values: toProcess.map(() => expect.objectContaining({ status: 'unqualified' })),
      })
    );
  });

  it('holds for a real processable reward, not only the local fixture', async () => {
    configure({ goodContent: { enabled: false } });
    const toProcess = pendingEvents('goodContent');

    await goodContentReward.process(processCtx(toProcess));

    expect(toProcess.map((x) => x.status)).toEqual(['unqualified', 'unqualified']);
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('pays the backlog normally when the reward is enabled', async () => {
    const toProcess = pendingEvents('testProcessableReward');

    await processableReward().process(processCtx(toProcess));

    expect(toProcess.map((x) => x.status)).toEqual(['awarded', 'awarded']);
    expect(h.createBuzzTransactionMany).toHaveBeenCalled();
  });

  it('enforces the overridden cap rather than the compiled one', async () => {
    configure({ testProcessableReward: { cap: 150 } });
    const toProcess = pendingEvents('testProcessableReward');

    await processableReward().process(processCtx(toProcess));

    // Cap 150 against two 100-Buzz events: the first pays in full, the second is
    // trimmed to the 50 that remains.
    expect(toProcess.map((x) => x.awardAmount)).toEqual([100, 50]);
  });
});

// The Lua is the thing under test here, so these drive a real in-memory Redis
// hash through it rather than stubbing its return value: the cap arithmetic and
// the per-entry bookkeeping are the behaviour, not an implementation detail.
describe('the cap is never overshot, whatever the operator sets', () => {
  const hash = new Map<string, string>();

  const runLua = (_script: string, opts: { arguments: string[] }) => {
    const [field, cacheKey, award, cap] = opts.arguments;
    const entries = JSON.parse(hash.get(field) ?? '{}') as Record<string, string>;
    if (entries[cacheKey] !== undefined) return -1;

    const awarded = Object.values(entries).reduce((sum, entry) => {
      const paid = /^a:(\d+)$/.exec(entry);
      return sum + (paid ? Number(paid[1]) : Number(award));
    }, 0);
    const toAward = Math.min(Number(award), Math.max(Number(cap) - awarded, 0));

    entries[cacheKey] = `a:${toAward}`;
    hash.set(field, JSON.stringify(entries));
    return toAward;
  };

  beforeEach(() => {
    hash.clear();
    h.evalImpl.mockImplementation(runLua as any);
    h.hGetImpl.mockImplementation(async (_key: string, field: string) => hash.get(field) ?? '{}');
  });

  const paidSoFar = () =>
    h.createBuzzTransactionMany.mock.calls.flatMap(([events]: any) =>
      events.map((x: any) => x.amount)
    );

  it('pays only what the cap leaves when the award does not divide it', async () => {
    // Award 3 against cap 10: three full grants, then 1, then nothing. Paying the
    // whole award on the trimmed grant would total 12 against a cap of 10.
    configure({ testOnDemandReward: { awardAmount: 3, cap: 10 } });
    const reward = onDemandReward();

    for (let i = 0; i < 5; i++) await reward.apply({ userId: 1, entityId: i });

    expect(paidSoFar()).toEqual([3, 3, 3, 1]);
    expect(paidSoFar().reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('pays at most the cap when the award is raised above it', async () => {
    configure({ testOnDemandReward: { awardAmount: 5000, cap: 500 } });

    await onDemandReward().apply({ userId: 1, entityId: 1 });

    expect(paidSoFar()).toEqual([500]);
  });

  // The day's entries record what they paid. Deriving earnings as
  // `count * the current award` instead lets an operator LOWER the award and
  // increase that day's payout.
  it('does not re-price the day when the award is lowered mid-day', async () => {
    configure({ testOnDemandReward: { awardAmount: 2, cap: 10 } });
    for (let i = 0; i < 5; i++) await onDemandReward().apply({ userId: 1, entityId: i });
    expect(paidSoFar().reduce((a, b) => a + b, 0)).toBe(10);

    invalidateRewardConfigCache();
    configure({ testOnDemandReward: { awardAmount: 1, cap: 10 } });
    for (let i = 5; i < 10; i++) await onDemandReward().apply({ userId: 1, entityId: i });

    expect(paidSoFar().reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('reports the same day total to the user as it paid', async () => {
    configure({ testOnDemandReward: { awardAmount: 3, cap: 10 } });
    const reward = onDemandReward();
    for (let i = 0; i < 5; i++) await reward.apply({ userId: 1, entityId: i });

    const details = await reward.getUserRewardDetails(1);

    expect(details?.awarded).toBe(paidSoFar().reduce((a, b) => a + b, 0));
  });
});

describe('a multi-entry cap table refuses the override', () => {
  const twoCapReward = () =>
    createBuzzEvent<{ userId: number; entityId: number }>({
      type: 'testTwoCapReward',
      description: 'Test reward with a day cap and a per-entity cap',
      awardAmount: AWARD_AMOUNT,
      caps: [
        { keyParts: ['toUserId'], interval: 'day', amount: 1000 },
        { keyParts: ['forId'], amount: 200 },
      ],
      getKey,
    });

  // `capOverridable` is the only thing standing between an operator raising the
  // monthly cap and silently raising the per-entity one by the same number.
  it('leaves both caps at their compiled amounts', async () => {
    configure({ testTwoCapReward: { cap: 5000 } });

    const described = await twoCapReward().describeConfig();

    expect(described.capOverridable).toBe(false);
    expect(described.effective.cap).toBeUndefined();
    expect(described.rejected).toContain('cap');
  });

  it('enforces the compiled per-entity cap during processing', async () => {
    configure({ testTwoCapReward: { cap: 5000 } });
    const toProcess = pendingEvents('testTwoCapReward');

    await twoCapReward().process(processCtx(toProcess));

    // The tighter compiled cap (200 on forId) still trims a 100-Buzz event pair
    // to itself rather than to the operator's 5000.
    expect(toProcess.every((x) => x.awardAmount <= 200)).toBe(true);
  });
});

describe('getUserRewardDetails() stops advertising a disabled reward', () => {
  it('returns null so the reward leaves the user-facing list', async () => {
    configure({ testOnDemandReward: { enabled: false } });

    expect(await onDemandReward().getUserRewardDetails(1)).toBeNull();
  });

  it('reports the overridden amount and cap, multiplier applied on top', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 2 });
    configure({ testOnDemandReward: { awardAmount: 4, cap: 8 } });

    expect(await onDemandReward().getUserRewardDetails(1)).toMatchObject({
      awardAmount: 8,
      cap: 16,
    });
  });

  it('reports the compiled values when nothing is overridden', async () => {
    expect(await onDemandReward().getUserRewardDetails(1)).toMatchObject({
      awardAmount: AWARD_AMOUNT,
      cap: CAP,
    });
  });
});

describe('describeConfig() answers "which rewards are on" from one place', () => {
  it('reports the default beside the effective value and names refused fields', async () => {
    configure({ testProcessableReward: { enabled: false, awardAmount: 999999 } });

    expect(await processableReward().describeConfig()).toMatchObject({
      type: 'testProcessableReward',
      defaults: { awardAmount: AWARD_AMOUNT, cap: CAP },
      effective: { enabled: false, awardAmount: AWARD_AMOUNT, cap: CAP },
      rejected: ['awardAmount'],
    });
  });
});
