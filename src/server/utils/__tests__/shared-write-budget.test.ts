import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import {
  reserveSharedWrite,
  SHARED_WRITE_BUDGET,
  type SharedWriteBudgetParams,
} from '~/server/utils/shared-storage-rate-limit';
import { createLuaRedis, type LuaRedis } from './redis-lua-harness';

/**
 * The write-budget script EXECUTES here (Lua via wasmoon) against an in-memory store; only the
 * redis transport is replaced. Every fixture is injected and deliberately unlike the production
 * constants, which are pinned separately at the bottom.
 */

// A start instant with a non-zero millisecond part, so TIME's microsecond field is exercised.
const T0 = Date.parse('2031-07-08T09:10:11.000Z') + 437;
const USER = 4127;
const APP = 'apb_budget_fixture';
const KEY = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:shared-write:v2:${APP}:${USER}`;

// Large enough that a bucket never binds unless a test means it to.
const LOOSE = { capacity: 1_000, refillIntervalMs: 1 };

function params(over: Partial<SharedWriteBudgetParams>): SharedWriteBudgetParams {
  return { burst: LOOSE, daily: LOOSE, rejections: LOOSE, ...over };
}

let lua: LuaRedis;

beforeEach(() => {
  resetSharedMocks();
  lua = createLuaRedis(T0);
  redisMock.redis.eval.mockImplementation(
    (script: string, options: { keys: string[]; arguments: string[] }) => lua.eval(script, options)
  );
});

afterEach(() => {
  expect(lua.errors).toEqual([]);
});

async function reserveTimes(n: number, p: SharedWriteBudgetParams) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await reserveSharedWrite(USER, APP, p));
  return out;
}

function snapshot() {
  return { hash: lua.hash(KEY), pttl: lua.pttl(KEY) };
}

describe('write budget: burst bucket boundaries (capacity 7, one token per 137s)', () => {
  const P = params({ burst: { capacity: 7, refillIntervalMs: 137_000 } });

  it('allows exactly the capacity, then refuses with the wait for one token', async () => {
    const first = await reserveTimes(7, P);
    expect(first.every((r) => r.allowed)).toBe(true);
    await expect(reserveSharedWrite(USER, APP, P)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 137,
    });
  });

  it('is still refused at +136.4s (retryAfterSeconds rounds up to 1) and allowed at +137.6s', async () => {
    await reserveTimes(7, P);
    lua.nowMs = T0 + 136_400;
    await expect(reserveSharedWrite(USER, APP, P)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    lua.nowMs = T0 + 137_600;
    const later = await reserveSharedWrite(USER, APP, P);
    expect(later.allowed).toBe(true);
    // Exactly one token came back: the next call is refused again.
    expect((await reserveSharedWrite(USER, APP, P)).allowed).toBe(false);
  });

  it('an idle bucket refills to capacity and no further', async () => {
    // A slow rejection bucket keeps the hash alive long after the burst field went stale.
    const slow = { ...P, rejections: { capacity: 1_000, refillIntervalMs: 9_000_000 } };
    const [, second] = await reserveTimes(2, slow);
    if (!second.allowed) throw new Error('expected a reservation');
    await second.release({ rejected: true });
    lua.nowMs = T0 + 5_000_000;
    expect(lua.hash(KEY)).toBeDefined();

    expect((await reserveTimes(7, slow)).every((r) => r.allowed)).toBe(true);
    expect((await reserveSharedWrite(USER, APP, slow)).allowed).toBe(false);
  });

  it('a refused call leaves the stored state untouched and writes nothing', async () => {
    await reserveTimes(7, P);
    lua.nowMs = T0 + 50_000;
    const before = snapshot();
    const callsBefore = lua.calls.length;

    expect((await reserveSharedWrite(USER, APP, P)).allowed).toBe(false);

    lua.nowMs = T0 + 50_000;
    expect(snapshot()).toEqual(before);
    const written = lua.calls.slice(callsBefore).map(([command]) => command);
    expect(written).toEqual(['TIME', 'HMGET']);
  });

  it('sets PEXPIRE to the time until every bucket is full again', async () => {
    await reserveTimes(3, P);
    // Three burst tokens out at one token per 137s → full again in 411s.
    expect(lua.pttl(KEY)).toBe(411_000);
    lua.nowMs = T0 + 410_999;
    expect(lua.hash(KEY)).toBeDefined();
    lua.nowMs = T0 + 411_000;
    expect(lua.hash(KEY)).toBeUndefined();
  });
});

describe('write budget: the daily bucket', () => {
  it('binds while burst tokens remain, and the wait is the daily one', async () => {
    const P = params({
      burst: { capacity: 7, refillIntervalMs: 137_000 },
      daily: { capacity: 3, refillIntervalMs: 911_000 },
    });
    expect((await reserveTimes(3, P)).every((r) => r.allowed)).toBe(true);
    await expect(reserveSharedWrite(USER, APP, P)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 911,
    });
  });
});

describe('write budget: release', () => {
  const P = params({
    burst: { capacity: 7, refillIntervalMs: 137_000 },
    rejections: { capacity: 2, refillIntervalMs: 1_009_000 },
  });

  it('a refund is capped at capacity', async () => {
    const r = await reserveSharedWrite(USER, APP, P);
    if (!r.allowed) throw new Error('expected a reservation');
    await r.release({ rejected: false });
    await r.release({ rejected: false });
    await r.release({ rejected: false });
    // Back to full, so the key is gone rather than holding a credit above capacity.
    expect(lua.hash(KEY)).toBeUndefined();

    expect((await reserveTimes(7, P)).every((x) => x.allowed)).toBe(true);
    expect((await reserveSharedWrite(USER, APP, P)).allowed).toBe(false);
  });

  it('a rejected release gives the write token back and charges the rejection bucket', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await reserveSharedWrite(USER, APP, P);
      if (!r.allowed) throw new Error('expected a reservation');
      await r.release({ rejected: true });
    }
    // Rejections empty → refused, with the rejection bucket's wait.
    await expect(reserveSharedWrite(USER, APP, P)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 1_009,
    });
    // The write tokens were all refunded: only the rejection bucket is drawn down.
    expect(lua.hash(KEY)).toEqual({
      b: String(T0),
      d: String(T0),
      r: String(T0 + 2 * 1_009_000),
    });
  });

  it('rejection debt is bounded at -capacity', async () => {
    const reservations = await reserveTimes(4, P);
    for (const r of reservations) if (r.allowed) await r.release({ rejected: true });
    for (const r of reservations) if (r.allowed) await r.release({ rejected: true });
    // 8 charges against capacity 2: the full-at instant stops at now + 2 * capacity intervals.
    expect(lua.hash(KEY)?.r).toBe(String(T0 + 4 * 1_009_000));
    await expect(reserveSharedWrite(USER, APP, P)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 3 * 1_009,
    });
  });
});

describe('write budget: transport', () => {
  it('keys the hash on (app, user) under the v2 namespace', async () => {
    await reserveSharedWrite(USER, APP, params({}));
    expect(redisMock.redis.eval.mock.calls[0][1]).toMatchObject({ keys: [KEY] });
  });

  it('fails OPEN when redis errors, with a release that does nothing', async () => {
    redisMock.redis.eval.mockRejectedValue(new Error('redis down'));
    const r = await reserveSharedWrite(USER, APP, params({}));
    expect(r.allowed).toBe(true);
    if (r.allowed) await expect(r.release({ rejected: true })).resolves.toBeUndefined();
    expect(redisMock.redis.eval).toHaveBeenCalledTimes(1);
  });

  it('swallows a redis error on release', async () => {
    const r = await reserveSharedWrite(USER, APP, params({}));
    redisMock.redis.eval.mockRejectedValueOnce(new Error('redis down'));
    if (!r.allowed) throw new Error('expected a reservation');
    await expect(r.release({ rejected: false })).resolves.toBeUndefined();
    expect(redisMock.redis.eval).toHaveBeenCalledTimes(2);
  });
});

describe('write budget: production constants', () => {
  it('pins the operator-approved numbers', () => {
    expect(SHARED_WRITE_BUDGET).toEqual({
      burst: { capacity: 10, refillIntervalMs: 360_000 },
      daily: { capacity: 50, refillIntervalMs: 1_728_000 },
      rejections: { capacity: 10, refillIntervalMs: 1_800_000 },
    });
  });
});
