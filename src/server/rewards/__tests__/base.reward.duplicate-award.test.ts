import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// An on-demand reward's `externalTransactionId` carries no date, so the ledger
// refuses a repeat award for the lifetime of the key, while the Redis dedup entry
// that is supposed to say "already rewarded" shares a hash field - and an expiry -
// with the day's cap accounting. A re-reaction on a later day therefore re-qualifies,
// is refused by the ledger, and used to still consume the user's daily cap and be
// recorded as `awarded` (ClickUp 868m7r4p0: measured 26,408 (user, entity, type)
// triples awarded on more than one UTC day in 14 days, against 0 second payments).
//
// The day boundary is an INPUT here: the redis fake models a hash with an EXPIREAT
// and drops it when the injected clock passes that timestamp, which is the only
// reason the second award reaches the ledger at all.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  // Snapshotted at insert time. `toClickhouseBuzzEvent` returns the event ITSELF when no
  // column needs coercing, so holding the argument would report the status a later write
  // gave it rather than the one that went over the wire.
  inserts: [] as any[],
  insertImpl: vi.fn(async () => undefined),
  createBuzzTransactionMany: vi.fn(async () => ({
    transactions: ['tx'],
    conflicts: [] as string[],
  })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: any[]) => {
      if ((args[0] as any)?.table === 'buzzEvents') {
        h.inserts.push(JSON.parse(JSON.stringify((args[0] as any).values)));
      }
      return h.insertImpl(...args);
    },
    $query: vi.fn(async () => [] as unknown[]),
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

import {
  createBuzzEvent,
  ON_DEMAND_REWARD_SCRIPT,
  ON_DEMAND_ZERO_ENTRY_SCRIPT,
} from '~/server/rewards/base.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const AWARD_AMOUNT = 2;
const CAP = 100;

// A hash with one expiry, as `REDIS_KEYS.BUZZ_EVENTS` is. `HSET` does not touch the
// expiry; only `EXPIREAT` sets it - so the day boundary belongs to the hash, exactly
// as the dedup entry and the cap accounting share it in production.
let hash: { fields: Record<string, string>; expireAt?: number } | undefined;

const seconds = () => Math.floor(Date.now() / 1000);
const live = () => {
  if (hash?.expireAt !== undefined && seconds() > hash.expireAt) hash = undefined;
  return hash;
};

/**
 * Transcription of the two production Lua scripts against that fake hash. It decides
 * nothing this suite asserts: whether a duplicate is recognised, whether the entry is
 * zeroed and what status is recorded are all decided in TypeScript by the code under test.
 */
const evalScript = (script: string, opts: { arguments: string[] }) => {
  const [field, cacheKey, award, cap, endOfDay] = opts.arguments;

  if (script === ON_DEMAND_REWARD_SCRIPT) {
    const cache = JSON.parse(live()?.fields[field] ?? '{}') as Record<string, string>;
    if (cache[cacheKey] !== undefined) return -1;

    const awarded = Object.values(cache).reduce((sum, entry) => {
      const paid = /^a:(\d+)$/.exec(String(entry));
      return sum + (paid ? Number(paid[1]) : Number(award));
    }, 0);
    const toAward = Math.min(Number(award), Math.max(Number(cap) - awarded, 0));

    cache[cacheKey] = `a:${toAward}`;
    hash = {
      fields: { ...(live()?.fields ?? {}), [field]: JSON.stringify(cache) },
      expireAt: Number(endOfDay),
    };
    return toAward;
  }

  if (script === ON_DEMAND_ZERO_ENTRY_SCRIPT) {
    const current = live();
    if (!current) return 0;
    const raw = current.fields[field];
    if (raw === undefined) return 0;
    const cache = JSON.parse(raw) as Record<string, string>;
    if (cache[cacheKey] === undefined) return 0;
    cache[cacheKey] = 'a:0';
    current.fields[field] = JSON.stringify(cache);
    return 1;
  }

  throw new Error(`redis fake got an unknown script: ${script.slice(0, 40)}`);
};

/** What the day's entries report as earned - the number the cap is enforced against. */
const capConsumed = () =>
  Object.values(live()?.fields ?? {})
    .flatMap((json) => Object.values(JSON.parse(json) as Record<string, string>))
    .reduce((sum, entry) => sum + Number(/^a:(\d+)$/.exec(String(entry))?.[1] ?? 0), 0);

const insertedRows = () => h.inserts.flat();

const encouragementLike = () =>
  createBuzzEvent<{ reactorId: number; entityId: number }>({
    type: 'encouragement',
    description: 'For encouraging others to post content',
    awardAmount: AWARD_AMOUNT,
    cap: CAP,
    onDemand: true,
    getKey: async (input) => ({
      toUserId: input.reactorId,
      forId: input.entityId,
      byUserId: input.reactorId,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  h.inserts.length = 0;
  hash = undefined;
  // Only Date - faking timers wholesale would stop `withRetries` resolving its backoff.
  vi.useFakeTimers({ toFake: ['Date'] });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  h.insertImpl.mockResolvedValue(undefined as any);
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
  h.createBuzzTransactionMany.mockResolvedValue({ transactions: ['tx'], conflicts: [] });
  redisMock.redis.eval.mockImplementation((script: string, opts: any) => evalScript(script, opts));
});

afterEach(() => {
  vi.useRealTimers();
});

// `evalScript` above is a SECOND DERIVATION of both Lua scripts, in another language.
// Nothing in the toolchain can see the two disagree, and the revert control cannot either:
// it reverts the TypeScript and leaves the transcription standing. These assertions do NOT
// prove the transcription is correct. They guarantee nobody edits the Lua without being
// told it exists. Equality rather than a substring match, because an INSERTION is the edit
// most likely to change what these scripts mean, and a substring match cannot see one.
describe('the redis fake transcribes the Lua, and this is what pins it', () => {
  const normalise = (script: string) => script.trim().replace(/\s+/g, ' ');
  const reason =
    'You changed the Lua. `evalScript` in this file re-implements it — make the two agree, then update this pin.';

  it('pins the award script the fake was written against', () => {
    expect(normalise(ON_DEMAND_REWARD_SCRIPT), reason).toBe(
      normalise(`
        local cacheJson = redis.call('HGET', KEYS[1], ARGV[1])
        local cache = cjson.decode(cacheJson or '{}')

        -- Check if already awarded (dedup by cache key)
        if cache[ARGV[2]] then
          return -1
        end

        -- Sum what the day's entries actually paid, and enforce the cap against that
        local awarded = 0
        for _, entry in pairs(cache) do
          local paid = string.match(tostring(entry), '^a:(%d+)$')
          awarded = awarded + (paid and tonumber(paid) or tonumber(ARGV[3]))
        end
        local remaining = math.max(tonumber(ARGV[4]) - awarded, 0)
        local toAward = math.min(tonumber(ARGV[3]), remaining)

        -- Update cache with new entry
        cache[ARGV[2]] = 'a:' .. tostring(toAward)
        redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(cache))

        -- Set hash expiry to end of UTC day
        redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[5]))

        return toAward
      `)
    );
  });

  it('pins the zero-entry script the fake was written against', () => {
    expect(normalise(ON_DEMAND_ZERO_ENTRY_SCRIPT), reason).toBe(
      normalise(`
        local cacheJson = redis.call('HGET', KEYS[1], ARGV[1])
        if not cacheJson then
          return 0
        end
        local cache = cjson.decode(cacheJson)
        if cache[ARGV[2]] == nil then
          return 0
        end
        cache[ARGV[2]] = 'a:0'
        redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(cache))
        return 1
      `)
    );
  });
});

describe('a repeat award the ledger refuses', () => {
  it('leaves the daily cap unconsumed and does not record it as awarded', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);

    // Past end of UTC day: the hash the dedup entry lives in expires, which is what lets
    // the same reaction re-qualify. The ledger then refuses it - `externalTransactionId`
    // has no date in it, so the award it already paid is still on file.
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    h.createBuzzTransactionMany.mockResolvedValue({
      transactions: [],
      conflicts: ['encouragement:99-7-7'],
    });

    await reward.apply({ reactorId: 7, entityId: 99 });

    // The repeat pays nothing, so it must take nothing from the 100/day the user can earn.
    // Stated as an amount rather than as `a:2` so an operator changing the award cannot
    // make this assertion wrong about a fix that still works.
    expect(capConsumed()).toBe(0);
    expect(insertedRows().map((row) => row.status)).toEqual(['awarded', 'awarded', 'capped']);

    const corrected = insertedRows().at(-1);
    expect(corrected).toMatchObject({ awardAmount: 0, version: 1 });
    expect(JSON.parse(corrected.transactionDetails)).toMatchObject({ statusRaw: 'duplicate' });
  });

  it('zeroes the entry the award script wrote, not some other one', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
    await reward.apply({ reactorId: 7, entityId: 99 });

    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    h.createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: ['x'] });
    await reward.apply({ reactorId: 7, entityId: 99 });

    const awardCall = redisMock.redis.eval.mock.calls.find(
      ([script]: any[]) => script === ON_DEMAND_REWARD_SCRIPT
    );
    const zeroCall = redisMock.redis.eval.mock.calls.find(
      ([script]: any[]) => script === ON_DEMAND_ZERO_ENTRY_SCRIPT
    );

    expect(zeroCall).toBeDefined();
    // Same hash field and same dedup key the award was written under. A zero aimed at a
    // key nobody holds returns 0 and silently leaves the cap consumed.
    expect(zeroCall![1].arguments).toEqual(awardCall![1].arguments.slice(0, 2));
  });

  it('does not recreate the hash when the day rolled over before the ledger answered', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
    await reward.apply({ reactorId: 7, entityId: 99 });

    // The day rolls over WHILE the ledger is answering, so the hash the award just wrote
    // is gone by the time the correction runs. Writing the zeroed entry anyway would
    // recreate the hash with NO expiry, and `rewardsDailyReset` is the only other thing
    // that removes it - a key nothing reclaims, invisible until someone reads Redis.
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    h.createBuzzTransactionMany.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-09-23T00:00:30Z'));
      return { transactions: [], conflicts: ['x'] };
    });

    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(hash).toBeUndefined();
  });

  it('leaves a settled award alone', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date('2026-09-21T12:00:00Z'));
    await reward.apply({ reactorId: 7, entityId: 99 });

    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    await reward.apply({ reactorId: 7, entityId: 100 });

    // Negative control for the two cases above: with no conflict from the ledger the second
    // award is real - it keeps its cap entry and is not corrected.
    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(insertedRows().map((row) => row.status)).toEqual(['awarded', 'awarded']);
    expect(
      redisMock.redis.eval.mock.calls.some(
        ([script]: any[]) => script === ON_DEMAND_ZERO_ENTRY_SCRIPT
      )
    ).toBe(false);
  });
});
