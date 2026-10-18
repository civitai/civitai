import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSysSelfHealWatchdog, instrumentCommands, type SysSelfHealSettings } from '../client';
import { redisEnvSchema } from '../env';
import { getSysInflight, resetSysInflight } from '../sys-inflight';

// The sys self-heal's TIMEOUT-RATE trigger (2026-10-18). The in-flight trigger reconnects only when
// more than 500 sys commands stay in flight for 20 s, but the 30 s per-command backstop keeps
// releasing callers, so a wedged LOW-TRAFFIC app never holds more than about `rate × 30 s` commands
// in flight and never healed: a wedged Sentinel client leaked for an hour until the process ran out
// of memory, with every sys command timing out and no reconnect. These cases drive the REAL command
// wrapper (instrumentCommands), the REAL timeout records (sys-timeouts) and the REAL watchdog as the
// package wires it (createSysSelfHealWatchdog), with the env DEFAULTS, against fake Sentinel
// connections whose commands never settle.

const defaults = redisEnvSchema.parse({
  REDIS_URL: 'redis://localhost:6379',
  REDIS_SYS_URL: 'redis://localhost:6380',
});

/** The watchdog settings startSysSelfHeal passes, taken from the env defaults. */
const SETTINGS: SysSelfHealSettings = {
  sysSelfHealEnabled: defaults.REDIS_SYS_SELFHEAL_ENABLED,
  sysSelfHealInflightThreshold: defaults.REDIS_SYS_SELFHEAL_INFLIGHT_THRESHOLD,
  sysSelfHealSustainedMs: defaults.REDIS_SYS_SELFHEAL_SUSTAINED_MS,
  sysSelfHealCooldownMs: defaults.REDIS_SYS_SELFHEAL_COOLDOWN_MS,
  sysSelfHealReconnectJitterMs: defaults.REDIS_SYS_SELFHEAL_RECONNECT_JITTER_MS,
  sysSelfHealTimeoutThreshold: defaults.REDIS_SYS_SELFHEAL_TIMEOUT_THRESHOLD,
  sysSelfHealTimeoutWindowMs: defaults.REDIS_SYS_SELFHEAL_TIMEOUT_WINDOW_MS,
};
const BACKSTOP_MS = defaults.REDIS_SYS_COMMAND_TIMEOUT_MS;
// Each case starts at a later clock than every earlier one, so whatever the module-level timeout
// records kept from earlier cases lie outside every window here.
let T0 = 0;

const never = () => new Promise<never>(() => undefined);

/**
 * What the n-th command (0-based) on a connection gets: a reply now ('ok'), a reply 35 s later,
 * after the backstop has released its caller ('late'), an immediate error ('reject'), or nothing
 * ever (undefined), so its caller is released only by the backstop.
 */
type Answer = 'ok' | 'late' | 'reject' | undefined;

/**
 * Wedged Sentinel-shaped sys connections (node-redis's RedisSentinel exposes `_execute`), each
 * instrumented as the package does, plus the client the watchdog reconnects. `connections` gives
 * each connection's answers; one connection that never answers by default.
 */
function harness(
  opts: {
    answers?: (n: number) => Answer;
    connections?: Array<(n: number) => Answer>;
    settings?: Partial<SysSelfHealSettings>;
  } = {}
) {
  const plans = opts.connections ?? [opts.answers ?? (() => undefined)];
  const sentinels = plans.map((answer) => {
    let n = 0;
    const sentinel = {
      _execute: vi.fn(() => {
        const a = answer(n++);
        if (a === 'ok') return Promise.resolve('OK');
        if (a === 'late') return new Promise((r) => setTimeout(() => r('OK'), BACKSTOP_MS + 5000));
        if (a === 'reject') return Promise.reject(new Error('ERR error reply'));
        return never();
      }),
    };
    instrumentCommands(sentinel, 'sys', { sysDeadlineMs: BACKSTOP_MS, sysInflightCap: 0 });
    return sentinel;
  });

  const target = { destroy: vi.fn(async () => undefined), connect: vi.fn(async () => undefined) };
  const watchdog = createSysSelfHealWatchdog([target], { ...SETTINGS, ...opts.settings });

  /** Timestamps of commands whose caller got the backstop's timeout error. */
  const timedOutAt: number[] = [];
  /** Times at which the watchdog decided to reconnect. */
  const healsAt: number[] = [];
  /** Sys in-flight count at each tick that decided to reconnect. */
  const inflightAtHeal: number[] = [];

  return {
    target,
    timedOutAt,
    healsAt,
    inflightAtHeal,
    /**
     * Run for `ms` in 1 s steps: issue one sys command on each connection every `everyMs`, advance
     * the clock (which fires due backstop timers), then tick the watchdog once, as its 1 s interval
     * does.
     */
    async run(ms: number, everyMs: number) {
      for (let t = 0; t < ms; t += 1000) {
        if (t % everyMs === 0) {
          for (const sentinel of sentinels) {
            void (sentinel as any)
              ._execute(false, () => undefined)
              .catch((e: Error) => {
                if (e.message === `sysRedis command timed out after ${BACKSTOP_MS}ms`) {
                  timedOutAt.push(Date.now());
                }
              });
          }
        }
        await vi.advanceTimersByTimeAsync(1000);
        const inflight = getSysInflight();
        if (watchdog.tick()) {
          healsAt.push(Date.now());
          inflightAtHeal.push(inflight);
        }
      }
      // Let a reconnect parked behind the jitter delay run.
      await vi.advanceTimersByTimeAsync(SETTINGS.sysSelfHealReconnectJitterMs);
    },
    /** Callers released by a timeout within the window ending now (what the trigger counts). */
    timeoutsInWindow() {
      const cutoff = Date.now() - SETTINGS.sysSelfHealTimeoutWindowMs;
      return timedOutAt.filter((t) => t > cutoff).length;
    },
  };
}

/** The metrics bridge the app installs; only the reconnect counter is observed here. */
const reconnectCounter = { inc: vi.fn() };
const metricsBridge = {
  redisCommandsInflight: { inc: () => undefined, dec: () => undefined },
  redisCommandDuration: { observe: () => undefined },
  redisSelfHealReconnectCounter: reconnectCounter,
};
type MetricsGlobal = { __civitaiRedisMetrics?: unknown };

describe('sys self-heal: timeout-rate trigger (wedged low-traffic client)', () => {
  beforeEach(() => {
    resetSysInflight();
    T0 += 100_000_000;
    reconnectCounter.inc.mockClear();
    (globalThis as MetricsGlobal).__civitaiRedisMetrics = metricsBridge;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as MetricsGlobal).__civitaiRedisMetrics;
  });

  it('WEDGE: every command hangs at one per 3 s → reconnects via forceSysReconnect, trigger "deadline", with in-flight far under 500', async () => {
    // A command every 3 s (about the rate the 2026-10-18 wedge timed out at). The first one is
    // answered (the client was healthy), then it wedges and nothing is answered again.
    const h = harness({ answers: (n) => (n === 0 ? 'ok' : undefined) });
    await h.run(100_000, 3000); // shorter than heal + cooldown, so exactly one heal is possible

    expect(h.healsAt).toHaveLength(1);
    // Timeouts start at 33 s; the 10th lands at 60 s, the tick the last success (t=0) leaves the
    // window too, so either condition alone would also give 60 s here (the window case below
    // separates them).
    expect(h.healsAt[0] - T0).toBe(60_000);
    // Reported as the timeout-rate ("deadline") trigger, with in-flight nowhere near the in-flight
    // trigger's threshold: the 9 commands issued at 33..57 s, still waiting on the 30 s backstop.
    expect(reconnectCounter.inc).toHaveBeenCalledTimes(1);
    expect(reconnectCounter.inc).toHaveBeenCalledWith({ trigger: 'deadline', client: 'sys' });
    expect(h.inflightAtHeal[0]).toBe(9);
    expect(h.inflightAtHeal[0]).toBeLessThan(SETTINGS.sysSelfHealInflightThreshold);
    // The reconnect went through the shared path: destroy() then connect() on the sys client.
    expect(h.target.destroy).toHaveBeenCalledTimes(1);
    expect(h.target.connect).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: the same wedge with the timeout trigger off never reconnects (the in-flight trigger cannot see it)', async () => {
    const h = harness({ settings: { sysSelfHealTimeoutThreshold: 0 } });
    await h.run(600_000, 3000);
    // Positive control on the fixture: the wedge really is timing out at the rate above.
    expect(h.timeoutsInWindow()).toBeGreaterThanOrEqual(19);
    expect(h.healsAt).toHaveLength(0);
    expect(h.target.destroy).not.toHaveBeenCalled();
  });

  it('timeouts interleaved with successes → no reconnect', async () => {
    // Same rate, but every 7th command (one every 21 s) gets a reply: the client is slow at some
    // things, not wedged. 18 of every 21 s worth of commands still time out.
    const h = harness({ answers: (n) => (n % 7 === 0 ? 'ok' : undefined) });
    await h.run(600_000, 3000);
    // The timeout count alone is well past the threshold; only the success guard holds it off.
    expect(h.timeoutsInWindow()).toBeGreaterThanOrEqual(SETTINGS.sysSelfHealTimeoutThreshold + 5);
    expect(h.healsAt).toHaveLength(0);
    expect(h.target.destroy).not.toHaveBeenCalled();
  });

  it('below-threshold timeouts (no successes at all) → no reconnect', async () => {
    // One command every 10 s, all hanging: 6 timeouts per 60 s, under the threshold of 10.
    const h = harness();
    await h.run(600_000, 10_000);
    expect(h.timeoutsInWindow()).toBe(6);
    expect(h.healsAt).toHaveLength(0);
    expect(h.target.destroy).not.toHaveBeenCalled();
  });

  it('after a heal the cooldown holds: a wedge that persists reconnects at most once per cooldown, never in a loop', async () => {
    // The reconnect does not cure this wedge (the fake keeps hanging every command after the first).
    const h = harness({ answers: (n) => (n === 0 ? 'ok' : undefined) });
    await h.run(600_000, 3000);

    expect(h.healsAt.length).toBeGreaterThanOrEqual(2); // it keeps trying while wedged...
    for (let i = 1; i < h.healsAt.length; i++) {
      // ...but never sooner than the cooldown after the previous attempt.
      expect(h.healsAt[i] - h.healsAt[i - 1]).toBeGreaterThanOrEqual(
        SETTINGS.sysSelfHealCooldownMs
      );
    }
    // 10 minutes at one attempt per >= 60 s cooldown.
    expect(h.healsAt.length).toBeLessThanOrEqual(10);
    expect(h.target.destroy).toHaveBeenCalledTimes(h.healsAt.length);
  });

  it('the window setting is the one counted: a 20 s window with threshold 5 heals at 48 s', async () => {
    // Commands 0 and 1 answered (last success at 3 s), then a wedge. With a 20 s window the success
    // has left it by 23 s, and the 5 timeouts at 36..48 s are inside it at 48 s. A 60 s window (the
    // cooldown's value) would hold the success until 63 s.
    const h = harness({
      answers: (n) => (n <= 1 ? 'ok' : undefined),
      settings: { sysSelfHealTimeoutWindowMs: 20_000, sysSelfHealTimeoutThreshold: 5 },
    });
    await h.run(55_000, 3000);
    expect(h.healsAt.map((t) => t - T0)).toEqual([48_000]);
  });

  it('a heal clears the record: with a 5 s cooldown the next heal needs 10 NEW timeouts (30 s later)', async () => {
    const h = harness({
      answers: (n) => (n === 0 ? 'ok' : undefined),
      settings: { sysSelfHealCooldownMs: 5_000 },
    });
    await h.run(100_000, 3000);
    // 60 s, then the 10 timeouts at 63..90 s. Without the clear, the old ones would re-trigger at 65 s.
    expect(h.healsAt.map((t) => t - T0)).toEqual([60_000, 90_000]);
  });

  it('a reply that arrives after the backstop released its caller still counts as a success → no reconnect', async () => {
    // Every 7th command answers 35 s after it was sent (its caller already timed out at 30 s).
    const h = harness({ answers: (n) => (n % 7 === 0 ? 'late' : undefined) });
    await h.run(600_000, 3000);
    expect(h.timeoutsInWindow()).toBeGreaterThanOrEqual(SETTINGS.sysSelfHealTimeoutThreshold + 5);
    expect(h.healsAt).toHaveLength(0);
  });

  it('an error reply is not a success: a wedge whose only replies are errors still reconnects', async () => {
    const h = harness({ answers: (n) => (n % 7 === 0 ? 'reject' : undefined) });
    await h.run(100_000, 3000);
    expect(h.healsAt).toHaveLength(1);
  });

  it('one wedged connection heals while the other keeps answering', async () => {
    // The serving connection hangs everything; the second (Buffer-mode) connection answers all.
    const h = harness({ connections: [() => undefined, () => 'ok'] });
    await h.run(100_000, 3000);
    // The wedged connection's timeouts start at 30 s; the 10th lands at 57 s.
    expect(h.healsAt.map((t) => t - T0)).toEqual([57_000]);
    expect(h.target.destroy).toHaveBeenCalledTimes(1);
  });

  it('a wedge on BOTH connections heals even when the traffic is split between them', async () => {
    // One command per connection every 9 s: each connection alone times out only ~7 per 60 s,
    // under the threshold; together ~13.
    const h = harness({ connections: [() => undefined, () => undefined] });
    await h.run(200_000, 9000);
    expect(h.healsAt.length).toBeGreaterThan(0);
  });
});
