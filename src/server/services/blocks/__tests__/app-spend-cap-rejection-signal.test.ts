import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OBSERVABILITY of the per-app spend-cap REJECTION path.
 *
 * ── Why this signal exists ───────────────────────────────────────────────────
 * The motivation for the whole cap-observability arc is "users hitting abuse
 * rejections they did not earn". A REJECTION is literally that event, and it was
 * uninstrumented: `reserveAppSpend` returned `reason: 'daily' | 'velocity' |
 * 'unavailable'` with no counter behind it.
 *
 * Its sibling `civitai_app_block_cap_limits_degraded_total` (#3528) cannot stand
 * in. That one counts cap-limit RESOLUTIONS that fell back to the strictest tier,
 * and it is rate-capped by a 5s fallback cache + single-flight — so a degrade
 * that affects 10 submits and one that affects 10,000 produce the SAME counter
 * value. It can say "something degraded"; it structurally cannot say how many
 * generations were turned away. This counter is one increment per DENIED submit,
 * with nothing in front of it, which is what makes it able to size impact.
 *
 * Three properties are load-bearing and pinned below:
 *   1. EVERY deny emits, with the reason that actually applied, and an ALLOWED
 *      submit emits nothing (an alert on this must mean something).
 *   2. It is NOT cached/deduplicated — N denials emit N times. This is the whole
 *      difference from the degrade counter.
 *   3. 🔴 It is NOT a failure path. A rejection is a deliberate, user-visible
 *      402/429; a throwing or broken metrics module must never convert it into a
 *      500, and must never change the rejection's own reason or refund.
 *
 * sysRedis is the same stateful in-memory fake as app-spend-cap.service.test.ts
 * so the real INCRBY accumulation drives the real deny branches; the limit
 * resolver is mocked so each case can pin the ceiling it is testing.
 */

const SPEND_CAP_PREFIX = 'system:blocks:app-spend-cap';

const { store, ttls, mockSysRedis, mockResolveAppCapLimits, mockRecordRejection, metricsModule } =
  vi.hoisted(() => {
    const store = new Map<string, number>();
    const ttls = new Map<string, number>();
    const mockSysRedis = {
      incrBy: vi.fn(async (key: string, n: number) => {
        const next = (store.get(key) ?? 0) + n;
        store.set(key, next);
        return next;
      }),
      decrBy: vi.fn(async (key: string, n: number) => {
        const next = (store.get(key) ?? 0) - n;
        store.set(key, next);
        return next;
      }),
      expire: vi.fn(async (key: string, seconds: number) => {
        ttls.set(key, seconds);
        return 1;
      }),
      ttl: vi.fn(async (key: string) => (ttls.has(key) ? ttls.get(key)! : 1000)),
    };
    const mockResolveAppCapLimits = vi.fn(
      async (_appBlockId: string): Promise<{ dailyBuzz: number; velocityMaxGens: number }> => ({
        dailyBuzz: 5_000_000,
        velocityMaxGens: 600,
      })
    );
    const mockRecordRejection = vi.fn((_reason: string): void => undefined);
    // `brokenExport` simulates the metrics module itself being unusable (a failed
    // dynamic import / a module whose shape is broken), as distinct from an
    // emitter that throws. Both must be swallowed, and they hit the guard from
    // different directions.
    const metricsModule = { brokenExport: false };
    return {
      store,
      ttls,
      mockSysRedis,
      mockResolveAppCapLimits,
      mockRecordRejection,
      metricsModule,
    };
  });

vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { BLOCKS: { APP_SPEND_CAP: 'system:blocks:app-spend-cap' } },
}));

vi.mock('~/server/services/blocks/app-cap-limits.service', () => ({
  resolveAppCapLimits: (appBlockId: string) => mockResolveAppCapLimits(appBlockId),
  invalidateAppCapLimits: vi.fn(),
  normalizeCapOverrideInput: vi.fn(),
  __resetAppCapLimitsCacheForTests: vi.fn(),
}));

// The service dynamic-imports the metrics module, so this mock applies. Only the
// rejection emitter is stubbed; the real prom-client module (name, label,
// cardinality) is exercised in
// src/server/metrics/__tests__/app-block-spend-cap-rejections.metrics.test.ts.
vi.mock('~/server/metrics/app-block-runtime.metrics', () => ({
  get recordAppSpendCapRejection() {
    if (metricsModule.brokenExport) throw new Error('metrics module failed to load');
    return mockRecordRejection;
  },
}));

import { STRICTEST_APP_CAP_LIMITS } from '../app-cap-limits.constants';
import { reserveAppSpend } from '../app-spend-cap.service';

const APP_BLOCK_ID = 'apb_reject_test';

function dailyKey(app = APP_BLOCK_ID): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${SPEND_CAP_PREFIX}:${app}:${today}`;
}

/** Reasons passed to the rejection emitter, in call order. */
function reasons(): string[] {
  return mockRecordRejection.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  store.clear();
  ttls.clear();
  for (const fn of [
    mockSysRedis.incrBy,
    mockSysRedis.decrBy,
    mockSysRedis.expire,
    mockSysRedis.ttl,
  ]) {
    fn.mockReset();
  }
  // 🔴 Implementations are RE-ESTABLISHED, not merely cleared: a fault-injection
  // case leaves a `mockRejectedValue` behind, which would otherwise leak into
  // every later test in the file.
  mockSysRedis.incrBy.mockImplementation(async (key: string, n: number) => {
    const next = (store.get(key) ?? 0) + n;
    store.set(key, next);
    return next;
  });
  mockSysRedis.decrBy.mockImplementation(async (key: string, n: number) => {
    const next = (store.get(key) ?? 0) - n;
    store.set(key, next);
    return next;
  });
  mockSysRedis.expire.mockImplementation(async (key: string, seconds: number) => {
    ttls.set(key, seconds);
    return 1;
  });
  mockSysRedis.ttl.mockImplementation(async (key: string) =>
    ttls.has(key) ? ttls.get(key)! : 1000
  );

  mockResolveAppCapLimits.mockReset();
  mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 5_000_000, velocityMaxGens: 600 });

  mockRecordRejection.mockReset();
  mockRecordRejection.mockImplementation(() => undefined);
  metricsModule.brokenExport = false;
});

describe('spend-cap rejection signal — every deny is counted, with the reason that applied', () => {
  it('a DAILY-ceiling deny emits `daily`', async () => {
    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 100, velocityMaxGens: 600 });

    const res = await reserveAppSpend(APP_BLOCK_ID, 101);

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('daily');
    expect(reasons()).toEqual(['daily']);
  });

  it('a VELOCITY-ceiling deny emits `velocity`', async () => {
    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 5_000_000, velocityMaxGens: 2 });

    expect((await reserveAppSpend(APP_BLOCK_ID, 0)).allowed).toBe(true);
    expect((await reserveAppSpend(APP_BLOCK_ID, 0)).allowed).toBe(true);
    const third = await reserveAppSpend(APP_BLOCK_ID, 0);

    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('velocity');
    expect(reasons()).toEqual(['velocity']);
  });

  it('a fail-closed deny (Redis error) emits `unavailable`', async () => {
    mockSysRedis.incrBy.mockRejectedValue(new Error('redis down'));

    const res = await reserveAppSpend(APP_BLOCK_ID, 100);

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unavailable');
    expect(reasons()).toEqual(['unavailable']);
  });

  it('a LIMIT-RESOLUTION throw also emits `unavailable` — infra, not abuse', async () => {
    // The other way into the fail-closed branch. It must not be mistaken for an
    // app burning its budget: nothing about this app was over any ceiling.
    mockResolveAppCapLimits.mockRejectedValue(new Error('resolver exploded'));

    const res = await reserveAppSpend(APP_BLOCK_ID, 100);

    expect(res.reason).toBe('unavailable');
    expect(reasons()).toEqual(['unavailable']);
    expect(res.limits).toEqual(STRICTEST_APP_CAP_LIMITS);
  });

  it('🔴 the emitted reason always MATCHES the reason the caller is told', async () => {
    // The counter and the user-facing rejection must not be able to disagree —
    // an operator correlating a support report against the metric is relying on
    // exactly that. Drives all three branches in one pass.
    const observed: string[] = [];

    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 100, velocityMaxGens: 600 });
    observed.push((await reserveAppSpend('apb_a', 101)).reason!);

    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 5_000_000, velocityMaxGens: 1 });
    await reserveAppSpend('apb_b', 0);
    observed.push((await reserveAppSpend('apb_b', 0)).reason!);

    mockSysRedis.incrBy.mockRejectedValue(new Error('redis down'));
    observed.push((await reserveAppSpend('apb_c', 5)).reason!);

    expect(observed).toEqual(['daily', 'velocity', 'unavailable']);
    expect(reasons()).toEqual(['daily', 'velocity', 'unavailable']);
  });

  it('an ALLOWED submit emits NOTHING (an alert on this must mean something)', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await reserveAppSpend(APP_BLOCK_ID, 10)).allowed).toBe(true);
    }
    expect(mockRecordRejection).not.toHaveBeenCalled();
  });

  it('🔴 counts AFFECTED GENERATIONS, not degradation events — N denials emit N times', async () => {
    // The property that makes this metric able to size impact, and the exact
    // property `civitai_app_block_cap_limits_degraded_total` lacks: that one is
    // rate-capped by a 5s fallback cache, so a burst against one degraded app
    // emits ONCE however many submits it turned away. Nothing caches this one.
    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 5_000_000, velocityMaxGens: 3 });

    let denied = 0;
    for (let i = 0; i < 50; i++) {
      if (!(await reserveAppSpend(APP_BLOCK_ID, 0)).allowed) denied++;
    }

    expect(denied).toBe(47);
    expect(mockRecordRejection).toHaveBeenCalledTimes(47);
    expect(new Set(reasons())).toEqual(new Set(['velocity']));
  });
});

describe('🔴 the rejection signal is NOT a failure path', () => {
  it('a THROWING emitter leaves a DAILY deny intact — same reason, no second refund', async () => {
    // The deny path already refunded the reserve before signalling. If the emit
    // escaped, the outer catch would (a) relabel this as `unavailable` — an abuse
    // rejection reported as infra — and (b) refund a SECOND time, driving the
    // per-app daily counter negative and handing the app free headroom.
    mockRecordRejection.mockImplementation(() => {
      throw new Error('prom registry exploded');
    });
    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 100, velocityMaxGens: 600 });

    // Land the counter at 100 (exactly at the ceiling) with an allowed submit…
    expect((await reserveAppSpend(APP_BLOCK_ID, 100)).allowed).toBe(true);
    mockSysRedis.decrBy.mockClear();

    // …then a submit that breaches it.
    const res = await reserveAppSpend(APP_BLOCK_ID, 50);

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('daily');
    // Exactly ONE refund of exactly the attempted cost.
    expect(mockSysRedis.decrBy).toHaveBeenCalledTimes(1);
    expect(mockSysRedis.decrBy).toHaveBeenCalledWith(dailyKey(), 50);
    expect(store.get(dailyKey())).toBe(100);
  });

  it('a THROWING emitter leaves a VELOCITY deny intact (still `velocity`, still denied)', async () => {
    mockRecordRejection.mockImplementation(() => {
      throw new Error('prom registry exploded');
    });
    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 5_000_000, velocityMaxGens: 1 });

    expect((await reserveAppSpend(APP_BLOCK_ID, 0)).allowed).toBe(true);
    const res = await reserveAppSpend(APP_BLOCK_ID, 0);

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('velocity');
  });

  it('🔴 a THROWING emitter on the fail-closed path RESOLVES — it never rejects into the caller', async () => {
    // The `unavailable` emit runs inside `reserveAppSpend`'s own catch, where
    // there is no outer belt left: an unguarded throw there escapes the function
    // entirely and the submit handler returns a 500 instead of the intended
    // fail-closed rejection. That is observability causing an outage.
    mockRecordRejection.mockImplementation(() => {
      throw new Error('prom registry exploded');
    });
    mockSysRedis.incrBy.mockRejectedValue(new Error('redis down'));

    const res = await reserveAppSpend(APP_BLOCK_ID, 100);

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unavailable');
    // The payload is intact too — the ceilings resolved before Redis failed, so
    // the caller still logs what this app was actually judged against.
    expect(res.limits).toEqual({ dailyBuzz: 5_000_000, velocityMaxGens: 600 });
  });

  it('a BROKEN metrics module (the import/destructure itself throws) does not break the deny', async () => {
    // Distinct from a throwing emitter: here the module never yields a usable
    // export at all — a failed dynamic import, a bundling break, a module whose
    // shape changed. The guard has to cover the `await import(...)` too, not just
    // the call.
    metricsModule.brokenExport = true;
    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 100, velocityMaxGens: 600 });

    const res = await reserveAppSpend(APP_BLOCK_ID, 101);

    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('daily');
    expect(mockRecordRejection).not.toHaveBeenCalled();
  });

  it('a broken metrics module does not stop LATER rejections from being counted', async () => {
    // A transient metrics failure must not leave the signal permanently dark —
    // there is no memoised import result or one-shot disable to get stuck.
    metricsModule.brokenExport = true;
    mockResolveAppCapLimits.mockResolvedValue({ dailyBuzz: 100, velocityMaxGens: 600 });
    await reserveAppSpend(APP_BLOCK_ID, 101);
    expect(mockRecordRejection).not.toHaveBeenCalled();

    metricsModule.brokenExport = false;
    await reserveAppSpend(APP_BLOCK_ID, 101);
    expect(reasons()).toEqual(['daily']);
  });

  it('a throwing emitter does not perturb an ALLOWED submit either', async () => {
    mockRecordRejection.mockImplementation(() => {
      throw new Error('prom registry exploded');
    });
    const res = await reserveAppSpend(APP_BLOCK_ID, 100);

    expect(res.allowed).toBe(true);
    expect(res.dailyKey).toBe(dailyKey());
    expect(store.get(dailyKey())).toBe(100);
  });
});
