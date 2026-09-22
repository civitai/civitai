import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// An on-demand reward's `externalTransactionId` carries no date, so the ledger
// refuses a repeat award for the lifetime of the key, while the Redis dedup entry
// that is supposed to say "already rewarded" shares a hash field - and an expiry -
// with the day's cap accounting. A re-reaction on a later day therefore re-qualifies,
// is refused by the ledger, and used to still consume the user's daily cap (ClickUp
// 868m7r4p0: 26,408 (user, entity, type) triples awarded on more than one UTC day in
// 14 days, against 0 second payments).
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
  getTransactionByExternalId: vi.fn(async () => null as { date: Date } | null),
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
  getTransactionByExternalId: (...args: any[]) => h.getTransactionByExternalId(...args),
  getMultipliersForUser: (...args: any[]) => h.getMultipliersForUser(...args),
}));

import { createBuzzEvent, ON_DEMAND_ZERO_ENTRY_SCRIPT } from '~/server/rewards/base.reward';
import { ON_DEMAND_REWARD_SCRIPT } from '~/server/rewards/base.reward';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import { rewardFailedCounter, rewardGivenCounter } from '~/server/prom/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const AWARD_AMOUNT = 2;
/** Deliberately different from AWARD_AMOUNT: a fix that subtracts the current award rather
 *  than writing a zero reads as correct while the two are equal. */
const SIBLING_AWARD = 3;
const CAP = 100;
const DAY_ONE = '2026-09-21T12:00:00Z';
const DAY_TWO = '2026-09-22T12:00:00Z';

/**
 * Hashes keyed by the Redis key the caller names, each with ONE expiry - as
 * `REDIS_KEYS.BUZZ_EVENTS` is. `HSET` creates a key with NO expiry and never touches an
 * existing one; only `EXPIREAT` sets it. Both of those are Redis properties rather than
 * script logic, so a script that writes where it should not is visible here.
 */
type Hash = { fields: Record<string, string>; expireAt?: number };
let store: Record<string, Hash> = {};

const seconds = () => Math.floor(Date.now() / 1000);
const live = (key: string): Hash | undefined => {
  const hash = store[key];
  if (hash?.expireAt !== undefined && seconds() > hash.expireAt) {
    delete store[key];
    return undefined;
  }
  return hash;
};
const hset = (key: string, field: string, value: string) => {
  const hash = live(key) ?? { fields: {} };
  hash.fields[field] = value;
  store[key] = hash;
};

/**
 * Transcription of the two production Lua scripts. It decides nothing this suite asserts
 * about the fix: recognising a refused award, looking the transaction up and zeroing the
 * entry are all TypeScript in the code under test. It is still a SECOND DERIVATION of the
 * scripts, in another language - see the pin below for what that buys and what it does not.
 */
const evalScript = (script: string, opts: { keys: string[]; arguments: string[] }) => {
  const key = opts.keys[0];
  const [field, cacheKey, award, cap, endOfDay] = opts.arguments;

  if (script === ON_DEMAND_REWARD_SCRIPT) {
    const cache = JSON.parse(live(key)?.fields[field] ?? '{}') as Record<string, string>;
    if (cache[cacheKey] !== undefined) return -1;

    const awarded = Object.values(cache).reduce((sum, entry) => {
      const paid = /^a:(\d+)$/.exec(String(entry));
      return sum + (paid ? Number(paid[1]) : Number(award));
    }, 0);
    const toAward = Math.min(Number(award), Math.max(Number(cap) - awarded, 0));

    cache[cacheKey] = `a:${toAward}`;
    hset(key, field, JSON.stringify(cache));
    store[key].expireAt = Number(endOfDay);
    return toAward;
  }

  if (script === ON_DEMAND_ZERO_ENTRY_SCRIPT) {
    const raw = live(key)?.fields[field];
    if (raw === undefined) return 0;
    const cache = JSON.parse(raw) as Record<string, string>;
    if (cache[cacheKey] === undefined) return 0;
    cache[cacheKey] = 'a:0';
    hset(key, field, JSON.stringify(cache));
    return 1;
  }

  throw new Error(`redis fake got an unknown script: ${script.slice(0, 40)}`);
};

/**
 * What the day's entries report as earned. Reads an unparseable entry as the FULL award,
 * exactly as the Lua's cap sum does - a helper that scored it 0 would call a fix that wrote
 * garbage a fix that consumed nothing.
 */
const capConsumed = (key = REDIS_KEYS.BUZZ_EVENTS) =>
  Object.values(live(key)?.fields ?? {})
    .flatMap((json) => Object.values(JSON.parse(json) as Record<string, string>))
    .reduce((sum, entry) => {
      const paid = /^a:(\d+)$/.exec(String(entry));
      return sum + (paid ? Number(paid[1]) : AWARD_AMOUNT);
    }, 0);

const insertedRows = () => h.inserts.flat();

const evalCalls = (script: string) =>
  redisMock.redis.eval.mock.calls.filter(([called]: any[]) => called === script);

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

/** The ledger refuses the repeat and reports the award it holds from `paidOn`. */
const ledgerRefuses = (paidOn: string) => {
  h.createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: ['x'] });
  h.getTransactionByExternalId.mockResolvedValue({ date: new Date(paidOn) });
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  h.inserts.length = 0;
  store = {};
  // Only Date - faking timers wholesale would stop `withRetries` resolving its backoff.
  vi.useFakeTimers({ toFake: ['Date'] });
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  h.insertImpl.mockResolvedValue(undefined as any);
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
  h.createBuzzTransactionMany.mockResolvedValue({ transactions: ['tx'], conflicts: [] });
  h.getTransactionByExternalId.mockResolvedValue(null);
  redisMock.redis.eval.mockImplementation((script: string, opts: any) => evalScript(script, opts));
});

afterEach(() => {
  vi.useRealTimers();
});

// `ON_DEMAND_REWARD_SCRIPT` is already pinned verbatim, line by line, in
// base.reward.config.test.ts - which also carries its own JS transcription of it. Do not add a
// second pin of that script here; pin only what is new.
//
// What this one buys: `evalScript` above re-implements the zero script in another language, and
// nothing in the toolchain can see the two disagree - a revert of the TypeScript leaves the
// transcription standing. This detects a CHANGE to the script, never a DISAGREEMENT with the
// fake, and its whole value is the failure message. Equality rather than a substring match,
// because an insertion is the edit most likely to change what the script means and a substring
// match cannot see one.
describe('the redis fake transcribes the zero script, and this is what pins it', () => {
  it('pins the script the fake was written against', () => {
    expect(
      ON_DEMAND_ZERO_ENTRY_SCRIPT.trim().replace(/\s+/g, ' '),
      'You changed the Lua. `evalScript` in this file re-implements it — make the two agree, then update this pin.'
    ).toBe(
      `
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
      `
        .trim()
        .replace(/\s+/g, ' ')
    );
  });
});

describe('a repeat award the ledger refuses', () => {
  it('leaves the daily cap unconsumed, and the entry still dedups the rest of the day', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_ONE));
    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);

    // Past end of UTC day: the hash the dedup entry lives in expires, which is what lets the
    // same reaction re-qualify. The ledger then refuses it and reports the award it already
    // paid, dated the previous day.
    // A different entity on day two, so the repeat below is zeroed inside a field that has
    // something else in it. Its award is raised first, which also makes the assertion below
    // discriminate a fix that subtracts the CURRENT award from one that writes a zero.
    vi.setSystemTime(new Date(DAY_TWO));
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      value: { rewards: { encouragement: { awardAmount: SIBLING_AWARD } } },
    } as any);
    invalidateRewardConfigCache();
    await reward.apply({ reactorId: 7, entityId: 100 });
    expect(capConsumed()).toBe(SIBLING_AWARD);

    ledgerRefuses(DAY_ONE);

    await reward.apply({ reactorId: 7, entityId: 99 });

    // The repeat pays nothing, so it must take nothing from the 100/day the user can earn.
    // Asserted against a POPULATED day: the sibling award above is what separates "zeroed this
    // entry" from "cleared the field", which would hand back a cap the user really spent.
    // Stated as an amount rather than as `a:2` so an operator changing the award cannot make
    // this assertion wrong about a fix that still works.
    expect(capConsumed()).toBe(SIBLING_AWARD);

    // Asked about the transaction the submit actually sent, not one re-derived here - a
    // re-derivation moves with the code and checks nothing.
    const submitted = h.createBuzzTransactionMany.mock.calls.at(-1)![0][0].externalTransactionId;
    // Bounded and not retried: this read runs inside the mutation that triggered the reward,
    // and a failed lookup ends exactly where a skipped one does - with the cap still consumed.
    expect(h.getTransactionByExternalId).toHaveBeenCalledWith(submitted, {
      timeoutMs: expect.any(Number),
      retries: 0,
    });
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(1);
    // Day one's award and day two's sibling. The refused repeat must not be counted.
    expect(rewardGivenCounter?.inc).toHaveBeenCalledTimes(2);

    // The entry is ZEROED, not removed - a third reaction the same day must still be deduped,
    // or the same reaction can be re-awarded repeatedly within one day.
    await reward.apply({ reactorId: 7, entityId: 99 });
    expect(h.createBuzzTransactionMany).toHaveBeenCalledTimes(3);
    expect(insertedRows()).toHaveLength(3);

    // The audit rows are deliberately left alone: `buzzEvents` is ReplacingMergeTree ordered by
    // the dedup key, so a corrected row replaces the original rather than joining it.
    expect(insertedRows().map((row) => row.status)).toEqual(['awarded', 'awarded', 'awarded']);
  });

  it('zeroes the entry the award script wrote, in the key it wrote it to', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_ONE));
    await reward.apply({ reactorId: 7, entityId: 99 });

    vi.setSystemTime(new Date(DAY_TWO));
    ledgerRefuses(DAY_ONE);
    await reward.apply({ reactorId: 7, entityId: 99 });

    const [awardCall] = evalCalls(ON_DEMAND_REWARD_SCRIPT);
    const [zeroCall] = evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT);

    expect(zeroCall).toBeDefined();
    // Same hash field and dedup key, in the same Redis key. A zero aimed anywhere else returns
    // 0 and silently leaves the cap consumed.
    expect(zeroCall[1].arguments).toEqual(awardCall[1].arguments.slice(0, 2));
    expect(zeroCall[1].keys).toEqual(awardCall[1].keys);
  });

  it('leaves the cap alone when the ledger holds an award from TODAY', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_TWO));
    // The retry case: this call's own attempt committed and the response was lost, so the
    // re-send is refused by the award it just made. Freeing the cap here would hand back an
    // award the user really received.
    ledgerRefuses(DAY_TWO);

    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(0);
  });

  it('leaves the cap alone for a payment at the day boundary itself', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_TWO));
    // Exactly 00:00:00.000 of the current UTC day. The ledger's clock and this process's are
    // not the same clock, so the boundary itself belongs to the side that keeps the cap.
    ledgerRefuses('2026-09-22T00:00:00.000Z');

    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(0);
  });

  it('leaves the cap alone for a payment minutes before the boundary', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_TWO));
    // Yesterday by the calendar, but within the skew grace: close enough to the boundary that
    // a clock disagreement could have put it on either side of it.
    ledgerRefuses('2026-09-21T23:58:00.000Z');

    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(0);
  });

  it('leaves the cap alone when the ledger has no record to date', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_TWO));
    h.createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: ['x'] });
    h.getTransactionByExternalId.mockResolvedValue(null);

    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(0);
  });

  it('does not recreate the hash when the day rolled over before the ledger answered', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_ONE));
    await reward.apply({ reactorId: 7, entityId: 99 });

    vi.setSystemTime(new Date(DAY_TWO));
    h.createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: ['x'] });
    h.getTransactionByExternalId.mockImplementation(async () => {
      // The day rolls over while the ledger is answering, so the hash the award just wrote is
      // gone by the time the correction runs. `HSET` on a missing key would recreate it with NO
      // expiry, and `rewardsDailyReset` is the only other thing that removes it.
      vi.setSystemTime(new Date('2026-09-23T00:00:30Z'));
      return { date: new Date(DAY_ONE) };
    });

    await reward.apply({ reactorId: 7, entityId: 99 });

    // The claim is "no hash exists without an expiry", which is what `HSET` on a missing key
    // would create and what nothing else reclaims. Asserting that directly rather than
    // asserting the key is absent, which is only the fake's lazy expiry showing.
    expect(Object.values(store).filter((hash) => hash.expireAt === undefined)).toEqual([]);
    // And the release really was attempted - otherwise this passes by doing nothing.
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(1);
  });

  it('survives a failed correction without failing the user action', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_ONE));
    await reward.apply({ reactorId: 7, entityId: 99 });

    vi.setSystemTime(new Date(DAY_TWO));
    ledgerRefuses(DAY_ONE);
    redisMock.redis.eval.mockImplementation((script: string, opts: any) => {
      if (script === ON_DEMAND_ZERO_ENTRY_SCRIPT) throw new Error('redis is down');
      return evalScript(script, opts);
    });

    await expect(reward.apply({ reactorId: 7, entityId: 99 })).resolves.toBeUndefined();
    expect(rewardFailedCounter?.inc).toHaveBeenCalled();
    // The cap stays consumed, which is the direction that does not hand back money.
    expect(capConsumed()).toBe(AWARD_AMOUNT);
  });

  it('leaves a settled award alone', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_ONE));
    await reward.apply({ reactorId: 7, entityId: 99 });

    vi.setSystemTime(new Date(DAY_TWO));
    await reward.apply({ reactorId: 7, entityId: 100 });

    // Negative control: with no refusal from the ledger the second award is real - it keeps its
    // cap entry, is counted as given, and nothing is looked up or zeroed.
    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(insertedRows().map((row) => row.status)).toEqual(['awarded', 'awarded']);
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(0);
    expect(h.getTransactionByExternalId).not.toHaveBeenCalled();
    expect(rewardGivenCounter?.inc).toHaveBeenCalledTimes(2);
  });

  it('leaves the cap alone when the ledger settled something as well as conflicting', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_ONE));
    await reward.apply({ reactorId: 7, entityId: 99 });

    // Both arrays populated cannot describe a single-transaction submit, so it says the caller's
    // assumption is broken rather than that this award was refused.
    vi.setSystemTime(new Date(DAY_TWO));
    h.createBuzzTransactionMany.mockResolvedValue({ transactions: ['tx'], conflicts: ['x'] });
    h.getTransactionByExternalId.mockResolvedValue({ date: new Date(DAY_ONE) });

    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(0);
  });

  it('leaves the cap alone when the ledger reports neither a settle nor a conflict', async () => {
    const reward = encouragementLike();

    vi.setSystemTime(new Date(DAY_ONE));
    await reward.apply({ reactorId: 7, entityId: 99 });

    // A dropped transaction: no success and no conflict. The money did not move, but nothing
    // says this award was already paid, so the cap entry stands.
    vi.setSystemTime(new Date(DAY_TWO));
    h.createBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
    h.getTransactionByExternalId.mockResolvedValue({ date: new Date(DAY_ONE) });

    await reward.apply({ reactorId: 7, entityId: 99 });

    expect(capConsumed()).toBe(AWARD_AMOUNT);
    expect(evalCalls(ON_DEMAND_ZERO_ENTRY_SCRIPT)).toHaveLength(0);
  });
});
