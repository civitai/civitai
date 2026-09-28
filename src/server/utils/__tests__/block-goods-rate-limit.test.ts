import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

import {
  BLOCK_GOOD_CAP_PER_DAY,
  BLOCK_GOOD_RATE_LIMIT_MAX,
  BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS,
  BLOCK_GOOD_READ_RATE_LIMIT_MAX,
  BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS,
  checkBlockGoodRateLimit,
  checkBlockGoodReadRateLimit,
  claimGoodIdempotency,
  computeGoodPurchaseFingerprint,
  finalizeGoodIdempotency,
  refundBlockGoodSpend,
  releaseGoodIdempotency,
  reserveBlockGoodSpend,
} from '../block-goods-rate-limit';

/**
 * Direct unit coverage for the DIGITAL GOODS purchase money-path primitives in
 * `../block-goods-rate-limit` — the limiter, the daily reserve/refund cap, and the
 * fingerprinted idempotency claim.
 *
 * 🔴 WHY THIS FILE EXISTS. Its only consumer
 * (`src/pages/api/v1/blocks/goods/purchase.ts`) is tested with all six of these
 * exports replaced by stubs, so until now every line below ran in production and in
 * no test at all. The suite is a case-for-case port of the reviewed sibling,
 * `./block-tip-rate-limit.test.ts`, because the module under test is a deliberate
 * sibling of `../block-tip-rate-limit` rather than a variation on its rules — a
 * copied module loses the cases nobody re-derived, so the port is the point.
 *
 * 🔴 HOW REDIS IS FAKED, AND WHY NOT THE WAY THE TIP SUITE DOES IT. The tip suite
 * declares its own per-file factory for the redis client shim. That shape is now a
 * guard failure for any NEW file — `no-direct-shared-module-mock` — and the tip file
 * passes only because it holds a grandfathered allowlist entry (as does its
 * hand-typed key block, under `no-hand-typed-redis-key-constants`). So this file
 * declares behaviour on the CANONICAL mock instead, which `src/__tests__/setup.ts`
 * has already registered globally.
 *
 * Two consequences worth stating, because they make this suite STRICTER than its
 * model rather than merely different:
 *
 *   1. `REDIS_KEYS` / `REDIS_SYS_KEYS` are the REAL constants here — the global
 *      factory spreads the actual package — where the tip suite substitutes its own
 *      literals (`TOKEN_RATE_LIMIT: 'rl'`). Every key asserted below is therefore the
 *      key production Redis actually sees, and a rename of one is a red test rather
 *      than an invisible drift. That drift class is real: 15 hand-typed constants had
 *      silently diverged before #4400.
 *   2. The canonical nodes are reset once per FILE, not per test, so the stateful
 *      behaviour is (re)installed in `beforeEach` by `installRedisBehaviour()`, which
 *      resets each node first — that also drains any `…Once` queue a previous test
 *      left unconsumed.
 */

// ── The fake ─────────────────────────────────────────────────────────────────────
//
// Two stores, because the module deliberately uses two clients: the volatile CACHE
// client (`redis`) for the per-instance limiter and the SYS client (`sysRedis`) for
// the money-path cap and the idempotency sentinel. Holding them apart is what makes
// "the limiter wrote to the cap's counter" a visible failure rather than a pass.
//
// Values are `string | number`: `incrBy`/`decrBy` coerce to number and `get` coerces
// to string, mirroring how a real Redis round-trips an integer through a text reply.
const sysStore = new Map<string, string | number>();
const sysTtls = new Map<string, number>();
const cacheStore = new Map<string, string | number>();
const cacheTtls = new Map<string, number>();

type SetOptions = { NX?: boolean; EX?: number } | undefined;

function installRedisBehaviour() {
  const counter =
    (store: Map<string, string | number>, sign: 1 | -1) => async (k: string, n: number) => {
      const v = Number(store.get(k) ?? 0) + sign * n;
      store.set(k, v);
      return v;
    };
  const expire = (ttls: Map<string, number>) => async (k: string, s: number) => {
    ttls.set(k, s);
    return true;
  };
  // -1 is Redis's "key exists, no TTL" and -2 its "no such key"; the module only ever
  // branches on `< 0`, so one negative stands in for both.
  const ttl = (ttls: Map<string, number>) => async (k: string) => ttls.get(k) ?? -1;

  const nodes = [
    ['sysRedis.incrBy', redisMock.sysRedis.incrBy, counter(sysStore, 1)],
    ['sysRedis.decrBy', redisMock.sysRedis.decrBy, counter(sysStore, -1)],
    ['sysRedis.expire', redisMock.sysRedis.expire, expire(sysTtls)],
    ['sysRedis.ttl', redisMock.sysRedis.ttl, ttl(sysTtls)],
    [
      'sysRedis.get',
      redisMock.sysRedis.get,
      async (k: string) => {
        const v = sysStore.get(k);
        return v == null ? null : String(v);
      },
    ],
    [
      'sysRedis.set',
      redisMock.sysRedis.set,
      async (k: string, val: string, opts: SetOptions) => {
        if (opts?.NX && sysStore.has(k)) return null; // NX: only set when absent
        sysStore.set(k, val);
        if (opts?.EX != null) sysTtls.set(k, opts.EX);
        return 'OK';
      },
    ],
    [
      'sysRedis.del',
      redisMock.sysRedis.del,
      async (k: string) => {
        const had = sysStore.has(k);
        sysStore.delete(k);
        sysTtls.delete(k);
        return had ? 1 : 0;
      },
    ],
    ['redis.incrBy', redisMock.redis.incrBy, counter(cacheStore, 1)],
    ['redis.expire', redisMock.redis.expire, expire(cacheTtls)],
    ['redis.ttl', redisMock.redis.ttl, ttl(cacheTtls)],
  ] as const;

  for (const [name, node, impl] of nodes) {
    // `mockReset` before `mockImplementation`: it clears call history AND any queued
    // `…Once` implementation, so a rejection a previous test queued cannot leak
    // forward into this one as a phantom redis outage.
    node.mockReset();
    // 🔴 Re-apply the name `mockReset` just cleared. Without it every
    // `toHaveBeenCalledWith` failure in this file reads "expected vi.fn() to be called
    // with…" and does not say WHICH client or command — and a test's failure message is
    // the whole of what it protects.
    node.mockName(name);
    node.mockImplementation(impl as (...args: unknown[]) => unknown);
  }
}

/**
 * Mid-day on purpose: 12 hours from either UTC midnight, so the UTC-day rollover is
 * the only boundary in play. Deliberately NOT the sibling suite's date — a copied
 * clock is one of the things a case-for-case port is supposed to make visible.
 */
const FROZEN_CLOCK = new Date('2026-05-18T12:00:30Z');

/**
 * 🔴 A LITERAL, NOT A DERIVATION — the UTC day of `FROZEN_CLOCK`, written out.
 *
 * Deliberately not `new Date().toISOString().slice(0, 10)`, which is byte-identical
 * to the expression `goodsCapWindowKey` uses in the module under test: an expectation
 * built that way MOVES WITH the implementation, which is the "never derive a test's
 * expectation from the implementation it tests" trap.
 *
 * ⚠️ BE PRECISE ABOUT WHAT THAT BUYS, because the sibling suite's comment once
 * oversold the same thing. The literal buys INDEPENDENCE and less machinery. It does
 * NOT reliably catch a switch to a LOCAL-date derivation: at 12:00:30Z the local and
 * UTC dates agree at every offset inside ±12h, i.e. in CI and in every deployment
 * timezone. Do not claim a detection property this has not been measured to have.
 */
const FROZEN_DAY = '2026-05-18';

// ── Fixtures ─────────────────────────────────────────────────────────────────────
//
// 🔴 PAIRWISE DISTINCT, and distinct from every constant an assertion below names
// (MAX 6, WINDOW 60, CAP 150_000, cap TTL 90_000, idem TTL 600). A fixture that can
// only ever produce a constant's own value cannot see a mutant that hardcodes that
// constant, so it survives a fully green suite. The two app ids and the two good ids
// are also distinct from each other, which is what makes a fingerprint mutant that
// SWAPS two fields visible rather than silently identical.
const USER = 8317;
const OTHER_USER = 4902;
const APP_A = 'apb_goodsA';
const APP_B = 'apb_goodsB';
const GOOD_HAT = 'gd_hat';
const GOOD_CAPE = 'gd_cape';
const PRICE = 1234;
const PRICE_OTHER = 5678;
const INSTANCE = 'bki_goods_1';

// The real key prefixes, written out: `REDIS_SYS_KEYS.BLOCKS.GOODS_CAP`,
// `REDIS_SYS_KEYS.BLOCKS.GOODS_IDEM` and `REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT`.
const CAP_KEY = `system:blocks:goods-cap:${USER}:${FROZEN_DAY}` as const;
const RL_KEY = `blocks:token-rate-limit:goods:${INSTANCE}:${USER}` as const;
const CAP_TTL_SECONDS = 25 * 60 * 60;

beforeEach(() => {
  // 🔴 FIRST, before the module derives any key. This pins what the MODULE computes;
  // `FROZEN_DAY` is the independent literal the assertions compare against. Both are
  // needed and neither derives from the other.
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_CLOCK);
  sysStore.clear();
  sysTtls.clear();
  cacheStore.clear();
  cacheTtls.clear();
  installRedisBehaviour();
});

afterEach(() => {
  // Hand the clock back so a fake timer cannot leak into a later file in this worker.
  vi.useRealTimers();
});

describe('the published money-path ceilings', () => {
  // Pinned as LITERALS so the boundary tests below carry their own meaning. Every
  // other assertion names the imported constant, which a mutant is free to move; this
  // is the one place that cannot. A deliberate ceiling change edits this line.
  it('are the reviewed values', () => {
    expect(BLOCK_GOOD_RATE_LIMIT_MAX).toBe(6);
    expect(BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(BLOCK_GOOD_CAP_PER_DAY).toBe(150_000);
    expect(BLOCK_GOOD_READ_RATE_LIMIT_MAX).toBe(120);
    expect(BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS).toBe(10);
  });

  it('the READ ceiling is far looser than the PURCHASE ceiling', () => {
    // The two limiters are deliberately asymmetric in BOTH dimensions — a mutant that
    // points one at the other's constants is caught here rather than by a magic number.
    expect(BLOCK_GOOD_READ_RATE_LIMIT_MAX).toBeGreaterThan(BLOCK_GOOD_RATE_LIMIT_MAX);
    expect(BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS).toBeLessThan(
      BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS
    );
  });
});

describe('reserveBlockGoodSpend', () => {
  it('reserves the amount, returns a UTC-day-scoped key, and SETS the TTL on the first write', async () => {
    const { total, key } = await reserveBlockGoodSpend(USER, PRICE);
    expect(total).toBe(PRICE);
    expect(key).toBe(CAP_KEY);
    expect(redisMock.sysRedis.expire).toHaveBeenCalledWith(key, CAP_TTL_SECONDS);
    expect(sysStore.get(key)).toBe(PRICE);
  });

  it('is keyed per USER and omits the app, so a publisher cannot multiply the ceiling', async () => {
    const mine = await reserveBlockGoodSpend(USER, PRICE);
    const theirs = await reserveBlockGoodSpend(OTHER_USER, PRICE);
    expect(mine.key).not.toBe(theirs.key);
    expect(mine.key).toBe(CAP_KEY);
    // No app segment anywhere in the key: the cap is a per-viewer aggregate across
    // every installed app, which is the property that makes it a real ceiling.
    expect(mine.key).not.toContain(APP_A);
  });

  it('accumulates concurrent reservations and does NOT re-arm the TTL when one is set', async () => {
    const first = await reserveBlockGoodSpend(USER, PRICE);
    (redisMock.sysRedis.expire as { mockClear: () => void }).mockClear();
    const second = await reserveBlockGoodSpend(USER, PRICE_OTHER);
    expect(second.total).toBe(PRICE + PRICE_OTHER); // atomic INCRBY accumulation
    expect(second.key).toBe(first.key);
    expect(redisMock.sysRedis.expire).not.toHaveBeenCalled();
  });

  it('re-arms a LOST TTL (ttl < 0) on a subsequent write (self-heal)', async () => {
    const { key } = await reserveBlockGoodSpend(USER, PRICE);
    sysTtls.delete(key); // a TTL-less key: a crash between INCRBY and EXPIRE, or a manual SET
    (redisMock.sysRedis.expire as { mockClear: () => void }).mockClear();
    await reserveBlockGoodSpend(USER, PRICE_OTHER);
    expect(redisMock.sysRedis.expire).toHaveBeenCalledWith(key, CAP_TTL_SECONDS);
  });

  it('FAILS-CLOSED (throws) on a redis error — it must NOT swallow one, the caller maps it to a 503', async () => {
    redisMock.sysRedis.incrBy.mockRejectedValueOnce(new Error('redis down'));
    await expect(reserveBlockGoodSpend(USER, PRICE)).rejects.toThrow('redis down');
  });

  it('rounds a fractional amount UP, so a sub-unit price cannot be reserved for free', async () => {
    const { total } = await reserveBlockGoodSpend(USER, 0.25);
    expect(total).toBe(1);
  });
});

describe('refundBlockGoodSpend', () => {
  it('decrements the EXACT captured key by the exact amount', async () => {
    const { key } = await reserveBlockGoodSpend(USER, PRICE);
    await refundBlockGoodSpend(key, PRICE);
    expect(redisMock.sysRedis.decrBy).toHaveBeenCalledWith(key, PRICE);
    expect(sysStore.get(key)).toBe(0);
  });

  it('MIDNIGHT STRADDLE: refunds the day it RESERVED, not a re-derived current-day key', async () => {
    // A request that reserved just before 00:00Z must refund YESTERDAY's counter even
    // though "now" is a new UTC day. The primitive takes the CAPTURED key, so a
    // re-derivation can never point it at the wrong day — and the wrong day would
    // permanently inflate one day's counter while crediting another.
    const yesterdayKey = `system:blocks:goods-cap:${USER}:2020-01-01` as const;
    sysStore.set(yesterdayKey, PRICE_OTHER);
    await refundBlockGoodSpend(yesterdayKey, PRICE_OTHER);
    expect(redisMock.sysRedis.decrBy).toHaveBeenCalledWith(yesterdayKey, PRICE_OTHER);
    expect(sysStore.get(yesterdayKey)).toBe(0);
    // The current-day key was never created, let alone credited.
    expect(sysStore.get(CAP_KEY)).toBeUndefined();
    expect(redisMock.sysRedis.decrBy).not.toHaveBeenCalledWith(CAP_KEY, expect.anything());
  });

  it('is best-effort — a rejected DECRBY never throws (a lost refund only over-counts)', async () => {
    const { key } = await reserveBlockGoodSpend(USER, PRICE);
    redisMock.sysRedis.decrBy.mockRejectedValueOnce(new Error('redis blip'));
    await expect(refundBlockGoodSpend(key, PRICE)).resolves.toBeUndefined();
  });

  it('rounds a fractional refund UP, matching the reservation so a straddle nets to zero', async () => {
    const { key, total } = await reserveBlockGoodSpend(USER, 0.25);
    await refundBlockGoodSpend(key, 0.25);
    expect(total).toBe(1);
    expect(sysStore.get(key)).toBe(0);
  });
});

describe('checkBlockGoodRateLimit', () => {
  it('allows the first attempt and arms the window TTL on it', async () => {
    const r = await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(r).toEqual({ allowed: true });
    expect(redisMock.redis.incrBy).toHaveBeenCalledWith(RL_KEY, 1);
    expect(redisMock.redis.expire).toHaveBeenCalledWith(
      RL_KEY,
      BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS
    );
  });

  it('BOUNDARY: allowed at exactly MAX, refused at MAX+1', async () => {
    // Walks the ceiling rather than asserting one side of it: this is what kills an
    // off-by-one (`<` for `<=`) in either direction.
    for (let i = 1; i <= BLOCK_GOOD_RATE_LIMIT_MAX; i++) {
      await expect(checkBlockGoodRateLimit(INSTANCE, USER), `attempt ${i} of MAX`).resolves.toEqual({
        allowed: true,
      });
    }
    const overflow = await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(overflow.allowed).toBe(false);
  });

  it('meters per INSTANCE — a second install has its own window', async () => {
    for (let i = 0; i <= BLOCK_GOOD_RATE_LIMIT_MAX; i++) await checkBlockGoodRateLimit(INSTANCE, USER);
    // The first instance is now refused; a different one is untouched.
    await expect(checkBlockGoodRateLimit(INSTANCE, USER)).resolves.toMatchObject({ allowed: false });
    await expect(checkBlockGoodRateLimit('bki_goods_2', USER)).resolves.toEqual({ allowed: true });
  });

  // 🔴 REGRESSION, not an invariant guard. Before the buyer entered the key this
  // assertion FAILED: both viewers incremented one bucket, so the second was
  // refused after the first had spent the window. A PAGE app is the reachable
  // case — it has no per-viewer instance row, so every viewer shares the
  // synthetic `page_<appBlockId>` id, and the ceiling was per-PLATFORM.
  it('meters per VIEWER on a SHARED page-app instance — one buyer cannot exhaust another', async () => {
    const PAGE_INSTANCE = 'page_apb_shared';
    const OTHER_USER = 9426; // distinct from USER (8317) and from every other fixture here

    for (let i = 0; i <= BLOCK_GOOD_RATE_LIMIT_MAX; i++) {
      await checkBlockGoodRateLimit(PAGE_INSTANCE, USER);
    }
    // The first viewer has spent their window on this page app...
    await expect(
      checkBlockGoodRateLimit(PAGE_INSTANCE, USER)
    ).resolves.toMatchObject({ allowed: false });
    // ...and a DIFFERENT viewer of the SAME page app is untouched.
    await expect(
      checkBlockGoodRateLimit(PAGE_INSTANCE, OTHER_USER)
    ).resolves.toEqual({ allowed: true });
  });

  it('keys the bucket on BOTH ids — neither alone identifies the window', async () => {
    // Pins the key SHAPE, so a future edit cannot quietly drop either half and
    // still pass the behavioural tests above (dropping the instance would make
    // one viewer's budget global across apps; dropping the buyer restores the
    // platform-wide bucket this change removed).
    await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(redisMock.redis.incrBy).toHaveBeenCalledWith(
      `blocks:token-rate-limit:goods:${INSTANCE}:${USER}`,
      1
    );
  });

  it('a refusal reports the LIVE TTL as retryAfterSeconds', async () => {
    for (let i = 0; i <= BLOCK_GOOD_RATE_LIMIT_MAX; i++) await checkBlockGoodRateLimit(INSTANCE, USER);
    cacheTtls.set(RL_KEY, 17); // distinct from WINDOW (60), so the fallback cannot fake this
    const r = await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(r).toEqual({ allowed: false, retryAfterSeconds: 17 });
  });

  it('a refusal falls back to the full window when the TTL is absent (never Retry-After: -1)', async () => {
    for (let i = 0; i <= BLOCK_GOOD_RATE_LIMIT_MAX; i++) await checkBlockGoodRateLimit(INSTANCE, USER);
    cacheTtls.delete(RL_KEY); // ttl → -1
    const r = await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(r).toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('re-arms a LOST TTL (ttl < 0) on a subsequent attempt (self-heal)', async () => {
    await checkBlockGoodRateLimit(INSTANCE, USER); // count 1 → arms
    cacheTtls.delete(RL_KEY); // TTL lost: the window would otherwise never expire
    (redisMock.redis.expire as { mockClear: () => void }).mockClear();
    await checkBlockGoodRateLimit(INSTANCE, USER); // count 2 → sees ttl < 0, re-arms
    expect(redisMock.redis.expire).toHaveBeenCalledWith(
      RL_KEY,
      BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS
    );
  });

  it('does NOT re-arm the TTL while one is set', async () => {
    await checkBlockGoodRateLimit(INSTANCE, USER);
    (redisMock.redis.expire as { mockClear: () => void }).mockClear();
    await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(redisMock.redis.expire).not.toHaveBeenCalled();
  });

  it('FAILS-CLOSED on a redis error — refused, never allowed (money path)', async () => {
    redisMock.redis.incrBy.mockRejectedValueOnce(new Error('redis down'));
    // 🔴 The mutation this exists to kill is DELETING THE `catch`: without it the call
    // rejects and this `await` fails the test. A `catch` that returned `allowed: true`
    // is killed by the same assertion.
    const r = await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(r).toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_GOOD_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('FAILS-CLOSED when the TTL read is what fails, not the INCRBY', async () => {
    // Reaches the `catch` through a DIFFERENT statement, so the guard is proven to
    // cover the whole body rather than one call. Count must be >1 for the ttl branch
    // to execute at all, which is why the first attempt runs unmocked.
    await checkBlockGoodRateLimit(INSTANCE, USER);
    redisMock.redis.ttl.mockRejectedValueOnce(new Error('redis down'));
    const r = await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(r).toMatchObject({ allowed: false });
  });

  it('uses the CACHE client, never the money-path sys counter', async () => {
    await checkBlockGoodRateLimit(INSTANCE, USER);
    expect(redisMock.sysRedis.incrBy).not.toHaveBeenCalled();
    expect(sysStore.size).toBe(0);
  });
});

describe('checkBlockGoodReadRateLimit (the entitlements READ limiter)', () => {
  // 🔴 The whole point of this function is that its POSTURE is the OPPOSITE of the
  // purchase limiter's — fail-OPEN, because refusing an entitlements read renders as
  // "you own nothing" — and that its key carries the VIEWER as well as the instance,
  // because a PAGE app's instance id is one synthetic string shared platform-wide by
  // every concurrent viewer. Both properties are seams: each looks like a harmless
  // simplification in isolation and is load-bearing here.
  const READ_KEY = `blocks:token-rate-limit:goods-read:${INSTANCE}:${USER}` as const;

  it('allows the first read and arms its OWN shorter window', async () => {
    const r = await checkBlockGoodReadRateLimit(INSTANCE, USER);
    expect(r).toEqual({ allowed: true });
    expect(redisMock.redis.incrBy).toHaveBeenCalledWith(READ_KEY, 1);
    expect(redisMock.redis.expire).toHaveBeenCalledWith(
      READ_KEY,
      BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS
    );
  });

  it('BOUNDARY: allowed at exactly MAX, refused at MAX+1', async () => {
    for (let i = 1; i <= BLOCK_GOOD_READ_RATE_LIMIT_MAX; i++) {
      await expect(
        checkBlockGoodReadRateLimit(INSTANCE, USER),
        `read ${i} of MAX`
      ).resolves.toEqual({ allowed: true });
    }
    const overflow = await checkBlockGoodReadRateLimit(INSTANCE, USER);
    expect(overflow.allowed).toBe(false);
  });

  it('is keyed per VIEWER — one viewer exhausting the window cannot refuse another', async () => {
    // Drop the viewer segment from the key and this is the test that goes red: on a
    // page app both viewers share `page_<appBlockId>`, so the second would be refused
    // because of the first's traffic and would be told they own nothing.
    for (let i = 0; i <= BLOCK_GOOD_READ_RATE_LIMIT_MAX; i++) {
      await checkBlockGoodReadRateLimit(INSTANCE, USER);
    }
    await expect(checkBlockGoodReadRateLimit(INSTANCE, USER)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(checkBlockGoodReadRateLimit(INSTANCE, OTHER_USER)).resolves.toEqual({
      allowed: true,
    });
  });

  it('does NOT share a bucket with the PURCHASE limiter', async () => {
    // A shared counter would let ordinary reads exhaust a viewer's purchase budget —
    // MAX_READ is 20x MAX, so the purchase path would be refused almost immediately.
    for (let i = 0; i < BLOCK_GOOD_RATE_LIMIT_MAX + 4; i++) {
      await checkBlockGoodReadRateLimit(INSTANCE, USER);
    }
    await expect(checkBlockGoodRateLimit(INSTANCE, USER)).resolves.toEqual({ allowed: true });
    expect(cacheStore.get(READ_KEY)).toBe(BLOCK_GOOD_RATE_LIMIT_MAX + 4);
    expect(cacheStore.get(RL_KEY)).toBe(1);
  });

  it('FAILS-OPEN on a redis error — a blink must not read as "you own nothing"', async () => {
    redisMock.redis.incrBy.mockRejectedValueOnce(new Error('redis down'));
    await expect(checkBlockGoodReadRateLimit(INSTANCE, USER)).resolves.toEqual({ allowed: true });
  });

  it('FAILS-OPEN on a NON-NUMERIC count rather than refusing for no reason', async () => {
    // `undefined <= max` is false, so without the explicit guard an unreadable reply
    // would refuse the read. Reaches the guard with a value no earlier branch rejects:
    // it is not 1, so the `count === 1` arm does not run first.
    redisMock.redis.incrBy.mockResolvedValueOnce('7' as unknown as number);
    await expect(checkBlockGoodReadRateLimit(INSTANCE, USER)).resolves.toEqual({ allowed: true });
  });

  it('a refusal reports the LIVE TTL, falling back to the window when it is absent', async () => {
    for (let i = 0; i <= BLOCK_GOOD_READ_RATE_LIMIT_MAX; i++) {
      await checkBlockGoodReadRateLimit(INSTANCE, USER);
    }
    cacheTtls.set(READ_KEY, 3); // distinct from the window (10) so the fallback cannot fake it
    await expect(checkBlockGoodReadRateLimit(INSTANCE, USER)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 3,
    });
    cacheTtls.delete(READ_KEY); // ttl → -1
    await expect(checkBlockGoodReadRateLimit(INSTANCE, USER)).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS,
    });
  });

  it('re-arms a LOST TTL (ttl < 0) on a subsequent read (self-heal)', async () => {
    await checkBlockGoodReadRateLimit(INSTANCE, USER);
    cacheTtls.delete(READ_KEY);
    (redisMock.redis.expire as { mockClear: () => void }).mockClear();
    await checkBlockGoodReadRateLimit(INSTANCE, USER);
    expect(redisMock.redis.expire).toHaveBeenCalledWith(
      READ_KEY,
      BLOCK_GOOD_READ_RATE_LIMIT_WINDOW_SECONDS
    );
  });

  it('never touches the money-path sys counter', async () => {
    await checkBlockGoodReadRateLimit(INSTANCE, USER);
    expect(redisMock.sysRedis.incrBy).not.toHaveBeenCalled();
    expect(sysStore.size).toBe(0);
  });
});

describe('computeGoodPurchaseFingerprint', () => {
  const base = { appBlockId: APP_A, goodId: GOOD_HAT, priceBuzz: PRICE };

  it('is STABLE for the same input (a retry must replay, not 422)', () => {
    expect(computeGoodPurchaseFingerprint(base)).toBe(computeGoodPurchaseFingerprint({ ...base }));
  });

  it('DIFFERS for each field changed independently — app, good, and price', () => {
    const fp = computeGoodPurchaseFingerprint(base);
    expect(computeGoodPurchaseFingerprint({ ...base, appBlockId: APP_B })).not.toBe(fp);
    expect(computeGoodPurchaseFingerprint({ ...base, goodId: GOOD_CAPE })).not.toBe(fp);
    expect(computeGoodPurchaseFingerprint({ ...base, priceBuzz: PRICE_OTHER })).not.toBe(fp);
  });

  it('🔴 changes with the CALLER-ASSERTED price, not only the catalog price', () => {
    // `priceBuzz` is the CATALOG price, so two requests can agree on it while
    // disagreeing about what the client believes. Omitting `expectedPriceBuzz`
    // meant a retry reusing the key with a different assertion replayed the first
    // attempt's 200 instead of earning the price-guard refusal it asked for — the
    // case this fingerprint's own contract claims to cover. The three states below
    // (absent / matching / mismatching) must all be distinct.
    const none = computeGoodPurchaseFingerprint(base);
    const asserted = computeGoodPurchaseFingerprint({ ...base, expectedPriceBuzz: PRICE });
    const wrong = computeGoodPurchaseFingerprint({ ...base, expectedPriceBuzz: PRICE_OTHER });
    expect(new Set([none, asserted, wrong]).size).toBe(3);
  });

  it('distinguishes a SWAP of app and good — the fields are not interchangeable', () => {
    // Only visible because the two fixture values are distinct strings; with
    // `appBlockId === goodId` a mutant that transposes them would be invisible.
    expect(
      computeGoodPurchaseFingerprint({ ...base, appBlockId: GOOD_HAT, goodId: APP_A })
    ).not.toBe(computeGoodPurchaseFingerprint(base));
  });

  it('is a 32-char hex digest (kept short on purpose; the stored record stays small)', () => {
    expect(computeGoodPurchaseFingerprint(base)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('goods purchase idempotency', () => {
  const FP = computeGoodPurchaseFingerprint({
    appBlockId: APP_A,
    goodId: GOOD_HAT,
    priceBuzz: PRICE,
  });
  // A DIFFERENT logical purchase under the same key: a different good at a different
  // price, so neither field alone can account for the mismatch.
  const FP_OTHER = computeGoodPurchaseFingerprint({
    appBlockId: APP_A,
    goodId: GOOD_CAPE,
    priceBuzz: PRICE_OTHER,
  });

  it('a first claim ACQUIRES the key with an in-progress record + a bounded TTL', async () => {
    const r = await claimGoodIdempotency(USER, APP_A, 'key-1', FP);
    expect(r.state).toBe('acquired');
    if (r.state !== 'acquired') throw new Error('unreachable');
    // The APP segment is load-bearing — see the cross-app case below.
    expect(r.key).toBe(`system:blocks:goods-idem:${USER}:${APP_A}:key-1`);
    // Set NX (so a concurrent attempt loses) with a TTL (so a lost finalize cannot
    // wedge the key forever), carrying the fingerprint and NO terminal status.
    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      r.key,
      JSON.stringify({ fp: FP }),
      expect.objectContaining({ NX: true, EX: expect.any(Number) })
    );
    expect(sysTtls.get(r.key)).toBeGreaterThan(0);
  });

  it('a concurrent claim while the first is IN PROGRESS returns in_progress (never a 2nd charge)', async () => {
    await claimGoodIdempotency(USER, APP_A, 'key-2', FP);
    const second = await claimGoodIdempotency(USER, APP_A, 'key-2', FP);
    expect(second.state).toBe('in_progress');
  });

  it('SET→GET RACE: the key existed for SET but GET returns null → in_progress, never a 2nd charge', async () => {
    // The winner released or expired the key between our NX failure and our read. The
    // tempting reading is "nothing is there, so claim it" — that races a live first
    // attempt into a second charge, so it must degrade to in_progress instead.
    redisMock.sysRedis.set.mockResolvedValueOnce(null); // NX lost…
    const r = await claimGoodIdempotency(USER, APP_A, 'key-race', FP); // …but the store is empty
    expect(redisMock.sysRedis.get).toHaveBeenCalledWith(
      `system:blocks:goods-idem:${USER}:${APP_A}:key-race`
    );
    expect(r.state).toBe('in_progress');
  });

  it('after finalize, a replay returns the cached TERMINAL result verbatim (no 2nd charge)', async () => {
    const first = await claimGoodIdempotency(USER, APP_A, 'key-3', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    const body = {
      ok: true,
      purchase: { id: 'bgp_1', goodId: GOOD_HAT, priceBuzz: PRICE },
      entitlement: { id: 'ent_1' },
    };
    await finalizeGoodIdempotency(first.key, 200, body, FP);

    const replay = await claimGoodIdempotency(USER, APP_A, 'key-3', FP);
    expect(replay.state).toBe('replay');
    if (replay.state !== 'replay') throw new Error('unreachable');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(body);
  });

  it('finalize stores the FINGERPRINT alongside status and body', async () => {
    // Carrying it forward is what keeps the mismatch check alive on a TERMINAL record;
    // dropping it would make every later claim on that key a mismatch (`undefined !==
    // fp`), i.e. a permanent 422 for a legitimate retry.
    const first = await claimGoodIdempotency(USER, APP_A, 'key-fp', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await finalizeGoodIdempotency(first.key, 200, { ok: true }, FP);
    expect(sysStore.get(first.key)).toBe(
      JSON.stringify({ fp: FP, status: 200, body: { ok: true } })
    );
  });

  it('a terminal 4xx is cached and replayed too (deterministic replay of the first outcome)', async () => {
    const first = await claimGoodIdempotency(USER, APP_A, 'key-4', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await finalizeGoodIdempotency(first.key, 400, { ok: false, error: 'insufficient funds' }, FP);

    const replay = await claimGoodIdempotency(USER, APP_A, 'key-4', FP);
    expect(replay).toMatchObject({ state: 'replay', status: 400 });
  });

  it('release DELETES the record so a genuine retry after a transient 429/503 can re-run', async () => {
    const first = await claimGoodIdempotency(USER, APP_A, 'key-5', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    await releaseGoodIdempotency(first.key);
    expect(sysStore.has(first.key)).toBe(false);
    // Gone → a retry ACQUIRES fresh and re-executes, rather than 409-in-progress.
    const retry = await claimGoodIdempotency(USER, APP_A, 'key-5', FP);
    expect(retry.state).toBe('acquired');
  });

  it('a MALFORMED stored value is treated as in_progress (never re-run on a value we cannot read)', async () => {
    const key = `system:blocks:goods-idem:${USER}:${APP_A}:key-6`;
    sysStore.set(key, '{not-json'); // a corrupt record: not valid JSON
    const r = await claimGoodIdempotency(USER, APP_A, 'key-6', FP);
    expect(r.state).toBe('in_progress');
  });

  it('claim FAILS-CLOSED (throws) on a redis error at claim time (money path → 503)', async () => {
    redisMock.sysRedis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(claimGoodIdempotency(USER, APP_A, 'key-7', FP)).rejects.toThrow('redis down');
  });

  it('claim FAILS-CLOSED (throws) when the GET after a lost NX errors', async () => {
    await claimGoodIdempotency(USER, APP_A, 'key-8', FP); // leaves the record
    redisMock.sysRedis.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(claimGoodIdempotency(USER, APP_A, 'key-8', FP)).rejects.toThrow('redis down');
  });

  it('finalize is best-effort — a redis error never throws into an already-shipped response', async () => {
    const first = await claimGoodIdempotency(USER, APP_A, 'key-9', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    redisMock.sysRedis.set.mockRejectedValueOnce(new Error('redis blip'));
    await expect(
      finalizeGoodIdempotency(first.key, 200, { ok: true }, FP)
    ).resolves.toBeUndefined();
  });

  it('release is best-effort — a redis error never throws (a stuck sentinel just 409s until its TTL)', async () => {
    const first = await claimGoodIdempotency(USER, APP_A, 'key-10', FP);
    if (first.state !== 'acquired') throw new Error('expected acquired');
    redisMock.sysRedis.del.mockRejectedValueOnce(new Error('redis blip'));
    await expect(releaseGoodIdempotency(first.key)).resolves.toBeUndefined();
  });

  it('two DIFFERENT keys claim independently (a distinct logical purchase is not deduped)', async () => {
    const a = await claimGoodIdempotency(USER, APP_A, 'key-11a', FP);
    const b = await claimGoodIdempotency(USER, APP_A, 'key-11b', FP);
    expect(a.state).toBe('acquired');
    expect(b.state).toBe('acquired');
  });

  describe('per-APP scoping', () => {
    it('the SAME key value under a DIFFERENT appBlockId claims independently — no cross-app replay', async () => {
      const a = await claimGoodIdempotency(USER, APP_A, 'buy1', FP);
      expect(a.state).toBe('acquired');
      if (a.state !== 'acquired') throw new Error('unreachable');
      await finalizeGoodIdempotency(
        a.key,
        200,
        { ok: true, purchase: { id: 'bgp_A', goodId: GOOD_HAT, priceBuzz: PRICE } },
        FP
      );

      // App B hardcodes the SAME literal key. It must not receive app A's cached body
      // — that would tell B's viewer a purchase they never made had succeeded, and
      // leak A's good and price — and B's own purchase must still run.
      const b = await claimGoodIdempotency(USER, APP_B, 'buy1', FP);
      expect(b.state).toBe('acquired');
      if (b.state !== 'acquired') throw new Error('unreachable');
      expect(b.key).not.toBe(a.key);
    });

    it('keys are injective across (user, app, key)', async () => {
      const claims = await Promise.all([
        claimGoodIdempotency(USER, APP_A, 'k', FP),
        claimGoodIdempotency(USER, APP_B, 'k', FP), // different app
        claimGoodIdempotency(OTHER_USER, APP_A, 'k', FP), // different user
      ]);
      const keys = claims.map((c) => (c.state === 'acquired' ? c.key : ''));
      expect(new Set(keys).size).toBe(3);
      expect(keys).not.toContain('');
    });
  });

  describe('payload fingerprint', () => {
    it('MISMATCH: the same key with a DIFFERENT payload is rejected, not replayed', async () => {
      const first = await claimGoodIdempotency(USER, APP_A, 'reused', FP);
      if (first.state !== 'acquired') throw new Error('expected acquired');
      await finalizeGoodIdempotency(first.key, 200, { ok: true, purchase: { id: 'bgp_1' } }, FP);

      // Same key, DIFFERENT good and price. Replaying would tell the app that a
      // purchase of the cape succeeded when the money actually bought the hat.
      const reused = await claimGoodIdempotency(USER, APP_A, 'reused', FP_OTHER);
      expect(reused.state).toBe('mismatch');
    });

    it('MISMATCH is detected while the first attempt is still IN PROGRESS too', async () => {
      await claimGoodIdempotency(USER, APP_A, 'reused2', FP);
      const reused = await claimGoodIdempotency(USER, APP_A, 'reused2', FP_OTHER);
      expect(reused.state).toBe('mismatch');
    });

    it('a matching fingerprint on a NON-terminal record is in_progress, not replay', async () => {
      // The discriminator between the two stored shapes is a NUMERIC `status`. A
      // mutant that treats any parsed record as terminal would replay
      // `{status: undefined, body: undefined}` — a 200-with-no-body to a caller whose
      // purchase is still in flight.
      await claimGoodIdempotency(USER, APP_A, 'inflight', FP);
      const again = await claimGoodIdempotency(USER, APP_A, 'inflight', FP);
      expect(again).toEqual({ state: 'in_progress' });
    });

    it('a NON-NUMERIC stored status is not replayed as terminal', async () => {
      const key = `system:blocks:goods-idem:${USER}:${APP_A}:badstatus`;
      sysStore.set(key, JSON.stringify({ fp: FP, status: '200', body: { ok: true } }));
      const r = await claimGoodIdempotency(USER, APP_A, 'badstatus', FP);
      expect(r.state).toBe('in_progress');
    });

    /**
     * 🔴 THE TWO UNREADABLE SHAPES GET THE SAME TREATMENT, and they used not to.
     *
     * A stored value that is VALID JSON but not an object (`null`, `123`, `"x"`)
     * has no readable `fp`, so it fell through to the mismatch branch and the
     * endpoint answered 422 "this key was already used for a different purchase"
     * — a statement about the caller that is false, and terminal-looking, for the
     * whole TTL. The adjacent unparseable case degraded to in_progress/409, which
     * is retryable. Both are the same fact: we cannot read the record.
     */
    it('🔴 claim/finalize/release survive a SYNCHRONOUS throw, not just a rejection', async () => {
      // A promise handler catches a REJECTION; it does not catch a synchronous
      // throw from the call itself, which is what a not-ready client does. The
      // two best-effort helpers used `.catch()` and therefore did NOT survive it:
      // `refundBlockGoodSpend`'s escape turned the endpoint's clean over-cap 400
      // into a 500, and `releaseGoodIdempotency`'s escaped the very recovery path
      // that exists to stop a sentinel wedging every retry.
      const throwSync = () => {
        throw new Error('client not ready');
      };
      redisMock.sysRedis.del.mockImplementation(throwSync);
      redisMock.sysRedis.decrBy.mockImplementation(throwSync);
      redisMock.sysRedis.set.mockImplementation(throwSync);

      await expect(
        releaseGoodIdempotency(
          `system:blocks:goods-idem:${USER}:${APP_A}:sync` as Parameters<
            typeof releaseGoodIdempotency
          >[0]
        )
      ).resolves.toBeUndefined();
      await expect(
        refundBlockGoodSpend(
          `system:blocks:goods-cap:${USER}:2026-09-27` as Parameters<
            typeof refundBlockGoodSpend
          >[0],
          100
        )
      ).resolves.toBeUndefined();
      await expect(
        finalizeGoodIdempotency(
          `system:blocks:goods-idem:${USER}:${APP_A}:sync` as Parameters<
            typeof finalizeGoodIdempotency
          >[0],
          200,
          { ok: true },
          FP
        )
      ).resolves.toBeUndefined();
    });

    it('a valid-JSON NON-OBJECT record is treated as in_progress, like an unparseable one', async () => {
      for (const stored of ['null', '123', '"x"', '[]']) {
        const key = `system:blocks:goods-idem:${USER}:${APP_A}:json-${stored.length}-${stored[0]}`;
        sysStore.set(key, stored);
        const r = await claimGoodIdempotency(USER, APP_A, `json-${stored.length}-${stored[0]}`, FP);
        expect(r.state, `stored ${stored}`).toBe('in_progress');
      }
    });
  });
});
