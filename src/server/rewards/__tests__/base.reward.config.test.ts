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

import { createBuzzEvent, ON_DEMAND_REWARD_SCRIPT } from '~/server/rewards/base.reward';
import type { BuzzEventLog } from '~/server/rewards/base.reward';
import { goodContentReward } from '~/server/rewards/passive/goodContent.reward';
import { configFromStoredValue, invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.eval.mockImplementation((...args: any[]) => h.evalImpl(...args));
redisMock.redis.hGet.mockImplementation((...args: any[]) => h.hGetImpl(...args));

const findUnique = dbMock.dbRead.keyValue.findUnique;
const configure = (rewards: Record<string, unknown>) =>
  findUnique.mockResolvedValue({ value: { rewards } });

// `describeConfig` is handed the config rather than reading one, so the operator
// views cannot pick up the grant path's per-pod memo. Resolves the same row
// `configure` stores, through the same parser the grant path uses.
const storedConfig = (rewards: Record<string, unknown>) => configFromStoredValue({ rewards });

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

  // `tonumber('Infinity')` is nil in Lua, so an uncapped reward passing Infinity
  // throws out of the script and into the triggering user mutation.
  it('passes a finite cap for a reward that has none', async () => {
    const uncapped = createBuzzEvent<{ userId: number; entityId: number }>({
      type: 'testUncappedReward',
      description: 'Test uncapped on-demand reward',
      awardAmount: 5,
      onDemand: true,
      getKey,
    });

    await uncapped.apply({ userId: 1, entityId: 42 });

    const [, options] = h.evalImpl.mock.calls[0] as any[];
    expect(Number.isFinite(Number(options.arguments[3]))).toBe(true);
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

// 🔴 Nothing here executes the Lua. There is no Lua interpreter and no Redis in
// the unit suite, so `runLua` below is a MODEL of the script, and these tests
// verify what `apply` does with what the script returns — which is where the
// over-cap payment lived. The script's own two properties are pinned separately
// by source assertions at the bottom of this file, because without them a revert
// of the script passes everything here: the model would keep behaving correctly.
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

  // Lowering a cap below what the day already paid is a first-week action on a
  // feature whose whole purpose is changing caps at runtime, and it is the only
  // thing that drives `remaining` negative. Without it the `Math.max(…, 0)` floor
  // in both the script and the model beside it is unreachable, so a mutant that
  // removes it survives and the reward starts paying negative Buzz.
  // Without the floor, `remaining` goes negative and the entry is written `a:-5`.
  // `parseEntryAmount`'s `^a:(\d+)$` refuses the minus, so the day total treats
  // that entry as a LEGACY one and counts it as a whole award. No payment is
  // made either way — `apply` reads every non-positive result as capped — so the
  // corrupted total is the only observable, and it appears at any negative depth.
  // (Exactly -1 additionally collides with the script's already-awarded sentinel.
  // Real, but not what this test measures, and not why the numbers below work.)
  it('pays nothing, and corrupts nothing, when a cap drops below what was paid', async () => {
    configure({ testOnDemandReward: { awardAmount: 3, cap: 10 } });
    for (let i = 0; i < 4; i++) await onDemandReward().apply({ userId: 1, entityId: i });
    const paidBefore = paidSoFar().reduce((a, b) => a + b, 0);
    expect(paidBefore).toBe(10);

    invalidateRewardConfigCache();
    configure({ testOnDemandReward: { awardAmount: 3, cap: 9 } });
    await onDemandReward().apply({ userId: 1, entityId: 99 });

    expect(paidSoFar().reduce((a, b) => a + b, 0)).toBe(paidBefore);

    // Structurally required, not defensive: `getUserRewardDetails` clamps with
    // `Math.min(sum, cap)`, so reading the day back while the cap is still below
    // the total reports the cap. Deleting this re-raise turns the test red on
    // correct code.
    invalidateRewardConfigCache();
    configure({ testOnDemandReward: { awardAmount: 3, cap: 100 } });

    expect((await onDemandReward().getUserRewardDetails(1))?.awarded).toBe(paidBefore);
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

  it('does not apply the multiplier twice to a trimmed grant', async () => {
    h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 2 });
    configure({ testOnDemandReward: { awardAmount: 3, cap: 10 } });
    const reward = onDemandReward();

    // Effective award 6 against effective cap 20: three full grants, then 2.
    for (let i = 0; i < 4; i++) await reward.apply({ userId: 1, entityId: i });

    expect(paidSoFar()).toEqual([6, 6, 6, 2]);
  });

  // Guard against the cap's `Math.min` hiding a count-based total: with the cap
  // reached, both readings collapse to the cap and the test proves nothing.
  it('reports the day total from what was paid, not from the current award', async () => {
    configure({ testOnDemandReward: { awardAmount: 2, cap: 100 } });
    for (let i = 0; i < 5; i++) await onDemandReward().apply({ userId: 1, entityId: i });

    invalidateRewardConfigCache();
    configure({ testOnDemandReward: { awardAmount: 1, cap: 100 } });

    // Five entries that paid 2 each. Counting them against the current award of
    // 1 would report 5.
    expect((await onDemandReward().getUserRewardDetails(1))?.awarded).toBe(10);
  });

  // `awarded` stopped being a proxy for "did it fire today" the moment entries
  // recorded what they paid: a grant the cap trimmed to zero happened and paid
  // nothing. `blocks.router`'s autoclaim gates on this rather than on the amount.
  it('counts a claim that the cap trimmed to zero', async () => {
    configure({ testOnDemandReward: { awardAmount: 3, cap: 0 } });
    const reward = onDemandReward();

    await reward.apply({ userId: 1, entityId: 1 });
    const details = await reward.getUserRewardDetails(1);

    expect(details?.awarded).toBe(0);
    expect(details?.awardedCount).toBe(1);
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
    const described = await twoCapReward().describeConfig(
      storedConfig({ testTwoCapReward: { cap: 5000 } })
    );

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

// Change-detectors, deliberately. The unit suite cannot run the script, so these
// are the only thing standing between a revert of it and a green run — the model
// in `runLua` above would go on producing the right numbers from the wrong code.
//
// 🔴 The first version of this block pinned only the two lines THIS work changed,
// and a reviewer executing the script found two survivors in the lines it did not:
// deleting `- awarded` from the cap arithmetic removed the daily cap entirely, and
// deleting the dedup block removed the double-award guard — both green, the second
// because the model implements dedup itself and kept returning -1 for code that no
// longer did. Anchoring what you edited is the natural failure here, because
// nothing in your attention points at the rest. Hence the whole-body pin below,
// which covers the properties nobody thought to enumerate.
describe('the on-demand Lua keeps the properties the model assumes', () => {
  const line = (needle: string) => expect(ON_DEMAND_REWARD_SCRIPT).toContain(needle);

  it('refuses a duplicate event, which is the whole reason the script is atomic', () => {
    expect(ON_DEMAND_REWARD_SCRIPT).toMatch(/if cache\[ARGV\[2\]\] then\s+return -1/);
  });

  it('records what each entry paid, not when it happened', () => {
    line("cache[ARGV[2]] = 'a:' .. tostring(toAward)");
  });

  it('sums the entries rather than counting them against the current award', () => {
    line('local awarded = 0');
    line('for _, entry in pairs(cache) do');
    line("string.match(tostring(entry), '^a:(%d+)$')");
    // The accumulation itself, not just the parse above it: replacing this one
    // line with `awarded + tonumber(ARGV[3])` restores the count-based reading
    // while leaving every other line of the script intact.
    line('awarded = awarded + (paid and tonumber(paid) or tonumber(ARGV[3]))');
  });

  // Anchored on the operators, not on `ARGV[4]`: that name survives the deletion
  // of the subtraction it was supposed to protect, which is how a mutant that
  // abolished the daily cap passed.
  it('subtracts what was already earned from the cap', () => {
    line('local remaining = math.max(tonumber(ARGV[4]) - awarded, 0)');
  });

  it('never grants more than the cap left', () => {
    line('local toAward = math.min(tonumber(ARGV[3]), remaining)');
  });

  it('persists the updated hash and expires it at end of day', () => {
    line("redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(cache))");
    // Without this the hash never expires and the daily cap never resets.
    line("redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[5]))");
  });

  it('returns the trimmed amount, not the requested one', () => {
    line('return toAward');
  });

  // The backstop for every property above and every one not listed. A reviewer
  // found two holes by executing mutants; assume there are more nobody tried.
  // This fails on any edit to the script including a reformat, which is the safe
  // direction: updating it forces re-deriving the model in `runLua` beside it.
  // Names the class for a legible failure. The pin below would catch it anyway.
  it('has no long-bracket comment neutralising part of the script', () => {
    expect(ON_DEMAND_REWARD_SCRIPT).not.toMatch(/--\[=*\[/);
  });

  // 🔴 This pin does NOT normalise, and that is the whole design.
  //
  // Three earlier versions each ignored something so the comparison would be
  // stable, and each time the thing ignored was the attack. Trimming and dropping
  // `--` lines let a `--[[ … --]]` wrapper delete its own delimiters and leave the
  // commented-out body matching perfectly — the double-award guard dead in Redis,
  // every assertion green. Stripping `--[[ … --]]` then let `--[==[ … --]==]`
  // through, because Lua's long-bracket form takes any number of `=` and the `--`
  // on the closer is just comment content. Each fix closed the spelling it was
  // shown, not the class.
  //
  // A normaliser cannot be trusted here because "what can neutralise a line" is
  // not a closed set. So nothing is ignored: every line of the script, including
  // blank ones, comments and indentation, is compared verbatim. Split per line
  // only so the failure is a one-line diff rather than a wall.
  //
  // ⚠️ What this is worth: it RAISES THE COST of a silent script revert. It does
  // not prevent one, and it exists only because nothing in this repo can execute
  // Lua. If another way to neutralise the script turns up, the answer is a Lua
  // interpreter in devDependencies or an integration test against a real Redis —
  // not another regex.
  it('matches the script this suite was written against, verbatim', () => {
    expect(ON_DEMAND_REWARD_SCRIPT.split('\n')).toEqual([
      '',
      "  local cacheJson = redis.call('HGET', KEYS[1], ARGV[1])",
      "  local cache = cjson.decode(cacheJson or '{}')",
      '',
      '  -- Check if already awarded (dedup by cache key)',
      '  if cache[ARGV[2]] then',
      '    return -1',
      '  end',
      '',
      "  -- Sum what the day's entries actually paid, and enforce the cap against that",
      '  local awarded = 0',
      '  for _, entry in pairs(cache) do',
      "    local paid = string.match(tostring(entry), '^a:(%d+)$')",
      '    awarded = awarded + (paid and tonumber(paid) or tonumber(ARGV[3]))',
      '  end',
      '  local remaining = math.max(tonumber(ARGV[4]) - awarded, 0)',
      '  local toAward = math.min(tonumber(ARGV[3]), remaining)',
      '',
      '  -- Update cache with new entry',
      "  cache[ARGV[2]] = 'a:' .. tostring(toAward)",
      "  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(cache))",
      '',
      '  -- Set hash expiry to end of UTC day',
      "  redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[5]))",
      '',
      '  return toAward',
      '',
    ]);
  });
});

describe('describeConfig() answers "which rewards are on" from one place', () => {
  it('reports the default beside the effective value and names refused fields', async () => {
    const config = storedConfig({
      testProcessableReward: { enabled: false, awardAmount: 999999 },
    });

    expect(await processableReward().describeConfig(config)).toMatchObject({
      type: 'testProcessableReward',
      defaults: { awardAmount: AWARD_AMOUNT, cap: CAP },
      effective: { enabled: false, awardAmount: AWARD_AMOUNT, cap: CAP },
      rejected: ['awardAmount'],
    });
  });
});
