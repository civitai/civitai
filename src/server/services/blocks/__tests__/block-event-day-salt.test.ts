import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as DaySaltModule from '../block-event-day-salt';

/**
 * A fake of the shared store, holding what a real one would: values with an absolute expiry.
 * Each test gets "processes" by re-importing the module under `vi.resetModules()`, so two of them
 * share THIS store while each has its own in-process state, which is the production topology.
 */
type Entry = { value: string; expiresAtSec: number };
const store = new Map<string, Entry>();
let storeNowMs = 0;
let storeDown = false;

function live(key: string): Entry | undefined {
  const entry = store.get(key);
  if (entry && entry.expiresAtSec * 1000 <= storeNowMs) {
    store.delete(key);
    return undefined;
  }
  return entry;
}

function installStore() {
  redisMock.sysRedis.set.mockImplementation(
    async (key: string, value: string, opts?: { NX?: boolean; EXAT?: number }) => {
      if (storeDown) throw new Error('store down');
      if (opts?.NX && live(key)) return null;
      store.set(key, { value, expiresAtSec: opts?.EXAT ?? Number.POSITIVE_INFINITY });
      return 'OK';
    }
  );
  redisMock.sysRedis.get.mockImplementation(async (key: string) => {
    if (storeDown) throw new Error('store down');
    return live(key)?.value ?? null;
  });
}

async function newProcess(): Promise<typeof DaySaltModule> {
  vi.resetModules();
  return import('../block-event-day-salt');
}

const DAY_1_NOON = Date.UTC(2031, 2, 14, 12, 0, 0);
const DAY_2_NOON = Date.UTC(2031, 2, 15, 12, 0, 0);
const DAY_1_KEY = 'system:blocks:event-day-salt:2031-03-14';

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  storeDown = false;
  storeNowMs = DAY_1_NOON;
  installStore();
});

describe('the shared daily salt', () => {
  it('two processes get the SAME salt for one UTC day', async () => {
    const a = await newProcess();
    const b = await newProcess();
    const saltA = await a.getBlockEventDaySalt(DAY_1_NOON);
    const saltB = await b.getBlockEventDaySalt(DAY_1_NOON + 60_000);
    expect(saltA).toEqual(expect.any(String));
    expect(saltA!.length).toBeGreaterThanOrEqual(32);
    expect(saltB).toBe(saltA);
    // It is the store's value, under the day's key.
    expect(store.get(DAY_1_KEY)?.value).toBe(saltA);
  });

  it('the salt is random: a fresh store on the same day yields a different one', async () => {
    const first = await (await newProcess()).getBlockEventDaySalt(DAY_1_NOON);
    store.clear();
    const second = await (await newProcess()).getBlockEventDaySalt(DAY_1_NOON);
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it('the next UTC day gets a different salt, under a different key', async () => {
    const proc = await newProcess();
    const day1 = await proc.getBlockEventDaySalt(DAY_1_NOON);
    storeNowMs = DAY_2_NOON;
    const day2 = await proc.getBlockEventDaySalt(DAY_2_NOON);
    expect(day2).toEqual(expect.any(String));
    expect(day2).not.toBe(day1);
    expect(store.get('system:blocks:event-day-salt:2031-03-15')?.value).toBe(day2);
  });

  it('NX race: both racers end up with the value the store kept', async () => {
    // Both processes issue their set-if-absent before either reads; exactly one wins.
    const a = await newProcess();
    const b = await newProcess();
    const [saltA, saltB] = await Promise.all([
      a.getBlockEventDaySalt(DAY_1_NOON),
      b.getBlockEventDaySalt(DAY_1_NOON),
    ]);
    const setCalls = redisMock.sysRedis.set.mock.calls.filter(([key]) => key === DAY_1_KEY);
    expect(setCalls).toHaveLength(2);
    expect(setCalls[0][1]).not.toBe(setCalls[1][1]);
    expect(setCalls.every(([, , opts]) => opts?.NX === true)).toBe(true);
    expect(saltA).toBe(setCalls[0][1]);
    expect(saltB).toBe(setCalls[0][1]);
  });

  it('expires the key just after its UTC day, not at an offset from creation', async () => {
    await (await newProcess()).getBlockEventDaySalt(DAY_1_NOON);
    // 2031-03-15T00:00:00Z plus the ten-minute margin.
    expect(store.get(DAY_1_KEY)?.expiresAtSec).toBe(Date.UTC(2031, 2, 15, 0, 10, 0) / 1000);
  });

  it('caches per process for the day: one store round trip, however many calls', async () => {
    const proc = await newProcess();
    const first = await proc.getBlockEventDaySalt(DAY_1_NOON);
    for (let i = 1; i <= 5; i += 1) {
      expect(await proc.getBlockEventDaySalt(DAY_1_NOON + i * 1000)).toBe(first);
    }
    expect(redisMock.sysRedis.set).toHaveBeenCalledTimes(1);
    expect(redisMock.sysRedis.get).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first calls in one process into one round trip', async () => {
    const proc = await newProcess();
    const salts = await Promise.all([1, 2, 3].map(() => proc.getBlockEventDaySalt(DAY_1_NOON)));
    expect(new Set(salts).size).toBe(1);
    expect(redisMock.sysRedis.set).toHaveBeenCalledTimes(1);
  });

  it('answers null when the store is down, and never a locally made salt', async () => {
    storeDown = true;
    const proc = await newProcess();
    expect(await proc.getBlockEventDaySalt(DAY_1_NOON)).toBeNull();
  });

  it('answers null when the store accepts the write but has nothing to read back', async () => {
    redisMock.sysRedis.get.mockImplementation(async () => null);
    const proc = await newProcess();
    expect(await proc.getBlockEventDaySalt(DAY_1_NOON)).toBeNull();
  });

  it('a process whose clock is far behind gets null rather than reviving an expired day', async () => {
    // The store is already 11 minutes into day 2; this process still believes it is day 1.
    storeNowMs = Date.UTC(2031, 2, 15, 0, 11, 0);
    const proc = await newProcess();
    expect(await proc.getBlockEventDaySalt(Date.UTC(2031, 2, 14, 23, 59, 0))).toBeNull();
    expect(live(DAY_1_KEY)).toBeUndefined();
  });

  it('backs off after a failure, then recovers once the store is back', async () => {
    storeDown = true;
    const proc = await newProcess();
    expect(await proc.getBlockEventDaySalt(DAY_1_NOON)).toBeNull();
    const callsAfterFailure = redisMock.sysRedis.set.mock.calls.length;
    expect(callsAfterFailure).toBe(1);

    storeDown = false;
    // Inside the back-off window the store is not asked again.
    expect(await proc.getBlockEventDaySalt(DAY_1_NOON + 4_000)).toBeNull();
    expect(redisMock.sysRedis.set.mock.calls.length).toBe(callsAfterFailure);
    // After it, the shared value is read.
    const salt = await proc.getBlockEventDaySalt(DAY_1_NOON + 6_000);
    expect(salt).toEqual(expect.any(String));
    expect(store.get(DAY_1_KEY)?.value).toBe(salt);
  });
});
