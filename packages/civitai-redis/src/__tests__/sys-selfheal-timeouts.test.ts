import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSysSelfHealWatchdog, instrumentCommands, type SysSelfHealSettings } from '../client';
import { redisEnvSchema } from '../env';
import { getSysInflight, resetSysInflight } from '../sys-inflight';

// The sys self-heal's TIMEOUT-RATE trigger (2026-10-18). The in-flight trigger reconnects only when
// more than 500 sys commands stay in flight for 20 s, but the 30 s per-command backstop keeps
// releasing callers, so a wedged LOW-TRAFFIC app never holds more than about `rate × 30 s` commands
// in flight and never healed: a wedged Sentinel client leaked for an hour until the process ran out
// of memory, with every sys command timing out and no reconnect. These cases drive the REAL command
// wrapper (instrumentCommands), the REAL timeout record (sys-timeouts) and the REAL watchdog as the
// package wires it (createSysSelfHealWatchdog), with the env DEFAULTS, against a fake Sentinel
// client whose commands never settle.

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
// record kept from an earlier case lies outside every window here. That isolates the cases without
// importing the record, which keeps this file collecting on a tree that lacks it (where every
// case must then fail on its own assertion).
let T0 = 0;

const never = () => new Promise<never>(() => undefined);

/**
 * A wedged Sentinel-shaped client (node-redis's RedisSentinel exposes `_execute`), plus the client
 * the watchdog reconnects. `answers(n)` says whether the n-th command (0-based) gets a reply; every
 * other command never settles, so its caller is released only by the backstop.
 */
function harness(
  opts: { answers?: (n: number) => boolean; settings?: Partial<SysSelfHealSettings> } = {}
) {
  let n = 0;
  const sentinel = {
    _execute: vi.fn(() => (opts.answers?.(n++) ? Promise.resolve('OK') : never())),
  };
  instrumentCommands(sentinel, 'sys', { sysDeadlineMs: BACKSTOP_MS, sysInflightCap: 0 });

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
     * Run for `ms` in 1 s steps: issue one sys command every `everyMs`, advance the clock (which
     * fires due backstop timers), then tick the watchdog once, as its 1 s interval does.
     */
    async run(ms: number, everyMs: number) {
      for (let t = 0; t < ms; t += 1000) {
        if (t % everyMs === 0) {
          void (sentinel as any)
            ._execute(false, () => undefined)
            .catch((e: Error) => {
              if (e.message === `sysRedis command timed out after ${BACKSTOP_MS}ms`) {
                timedOutAt.push(Date.now());
              }
            });
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
    const h = harness({ answers: (n) => n === 0 });
    await h.run(100_000, 3000); // shorter than heal + cooldown, so exactly one heal is possible

    expect(h.healsAt).toHaveLength(1);
    // Timeouts start at 33 s; the heal waits until the last success (t=0) leaves the 60 s window.
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
    const h = harness({ answers: (n) => n % 7 === 0 });
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
    const h = harness({ answers: (n) => n === 0 });
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
});
