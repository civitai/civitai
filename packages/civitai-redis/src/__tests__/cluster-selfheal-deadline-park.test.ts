import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { instrumentCommands } from '../client';
import { ClusterSelfHealWatchdog, type ClusterSelfHealDeps } from '../cluster-selfheal';
import { countClusterDeadlineHits, resetClusterDeadlineHits } from '../cluster-deadline-hits';
import { getClusterInflight, resetClusterInflight } from '../cluster-inflight';

/**
 * REGRESSION for the 2026-07-06 fleet-wide node-redis CLUSTER-client wedge (human rolling-restart,
 * self-heal 0-fired). This drives the REAL command-instrumentation wrapper (instrumentCommands),
 * the REAL slow-settle recorder + ring (cluster-deadline-hits), the REAL inflight counter, and the
 * REAL watchdog — NOT a constant stub — to reproduce the exact non-firing condition and prove the
 * fix engages the deadline (slow-settle) trigger.
 *
 * THE BUG: the deadline-hit trigger was fed ONLY by withCommandDeadline's onTimeout, i.e. a hit was
 * recorded ONLY when the per-command deadline REAPED a still-hanging command. During the incident
 * the slow cluster commands SETTLED on their own past the deadline (~29s tail; requests hung ~29s),
 * so the deadline never reaped them, onTimeout never fired, and the ring stayed EMPTY — even though
 * `redis_command_duration_seconds` plainly showed ~4/s commands over 15s. The trigger built to
 * catch exactly this wedge saw nothing.
 *
 * THE FIX: instrumentCommands' done() now records a slow-settle hit from the OBSERVED settle
 * duration (recordClusterCommandSettle) — the SAME signal the duration histogram uses — so the ring
 * reflects the wedge regardless of whether the deadline reaped the command.
 *
 * The wedge shape modeled: inflight stays UNDER the inflight threshold (so the legacy sustained-
 * inflight trigger structurally cannot fire) WHILE slow settles accumulate over the window.
 */

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the finally(done) → catch microtask chain settle (no real timers involved). */
const flush = () => Promise.resolve().then(() => Promise.resolve());

const WATCHDOG_CFG = {
  enabled: true,
  inflightThreshold: 50,
  sustainedMs: 20000,
  cooldownMs: 60000,
  deadlineHitThreshold: 10,
  deadlineHitWindowMs: 20000,
  reconnectJitterMs: 0,
} as const;

describe('cluster self-heal: deadline-park wedge (2026-07-06 regression)', () => {
  beforeEach(() => {
    resetClusterDeadlineHits();
    resetClusterInflight();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('FIX: slow cluster commands settling past the deadline record hits from done() → watchdog self-heals (trigger=deadline)', async () => {
    // A fake cluster client whose _execute HANGS, then settles ~29s later (the incident tail).
    // deadlineMs:0 models the deadline NOT reaping these (they settle on their own) — the exact
    // condition under which the OLD onTimeout recorder was silent. slowCommandMs:10000 arms the
    // settle-time recorder (the fix). routingRetryEnabled:false = plain pass-through.
    const N = 12; // >= the 10-hit trigger threshold
    const pending = Array.from({ length: N }, () => deferred<string>());
    let i = 0;
    const fake: { _execute: (...a: unknown[]) => Promise<string> } = {
      _execute: () => pending[i++].promise,
    };
    instrumentCommands(fake, 'cluster', {
      deadlineMs: 0,
      slowCommandMs: 10000,
      routingRetryEnabled: false,
    });

    // Issue N commands at t=0 — they hang. Inflight climbs but stays UNDER the 50 threshold, so the
    // legacy sustained-inflight trigger structurally cannot fire (this is the incident shape).
    const calls = Array.from({ length: N }, () =>
      (fake._execute('GET', 'k') as Promise<unknown>).catch(() => undefined)
    );
    expect(getClusterInflight()).toBe(N);
    expect(getClusterInflight()).toBeLessThan(WATCHDOG_CFG.inflightThreshold);

    // ~29s later they settle on their OWN (reject, as during the wedge). done() runs → observes
    // 29s >= 10s → records a slow-settle hit for EACH via the REAL recorder + REAL ring. The
    // deadline never reaped them (deadlineMs:0), so the OLD onTimeout path would record NOTHING.
    vi.setSystemTime(29000);
    pending.forEach((d) => d.reject(new Error('cluster command wedged ~29s')));
    await Promise.all(calls);

    // The REAL ring now reflects the wedge — exactly what the duration histogram saw, now visible to
    // the watchdog (closing the 2026-07-06 blind spot). Inflight has drained back to 0.
    expect(countClusterDeadlineHits(20000, 29000)).toBeGreaterThanOrEqual(
      WATCHDOG_CFG.deadlineHitThreshold
    );
    expect(getClusterInflight()).toBe(0);

    // Drive the REAL watchdog with the REAL ring as getDeadlineHits + the REAL inflight counter.
    const nowMs = 29000;
    let reconnects = 0;
    let firedTrigger: string | undefined;
    const deps: ClusterSelfHealDeps = {
      getInflight: () => getClusterInflight(), // 0 → inflight trigger cannot fire
      getDeadlineHits: (w) => countClusterDeadlineHits(w, nowMs),
      resetDeadlineHits: () => resetClusterDeadlineHits(),
      reconnect: () => {
        reconnects++;
        return Promise.resolve();
      },
      now: () => nowMs,
      log: () => {},
      onReconnect: (_inflight, trigger) => {
        firedTrigger = trigger;
      },
    };
    const watchdog = new ClusterSelfHealWatchdog({ ...WATCHDOG_CFG }, deps);

    expect(watchdog.tick()).toBe(true);
    await flush();
    expect(reconnects).toBe(1);
    // Fired via the DEADLINE (slow-settle) path — the trigger the inflight path could never reach.
    expect(firedTrigger).toBe('deadline');
  });

  it('BUG SHAPE: without settle-time recording (slowCommandMs disabled) the same wedge is invisible → self-heal 0-fires', async () => {
    // Identical wedge, but the settle-time recorder disabled — models the PRE-FIX behavior where
    // done() did not record slow settles and the only recorder (withCommandDeadline.onTimeout) is
    // silent because the deadline never reaps a self-settling command. This is the 2026-07-06 blind
    // spot: a real, sustained wedge that the watchdog cannot see.
    const N = 20;
    const pending = Array.from({ length: N }, () => deferred<string>());
    let i = 0;
    const fake: { _execute: (...a: unknown[]) => Promise<string> } = {
      _execute: () => pending[i++].promise,
    };
    instrumentCommands(fake, 'cluster', {
      deadlineMs: 0,
      slowCommandMs: 0, // recording OFF — the pre-fix onTimeout-only path had nothing to fire it
      routingRetryEnabled: false,
    });

    const calls = Array.from({ length: N }, () =>
      (fake._execute('GET', 'k') as Promise<unknown>).catch(() => undefined)
    );
    vi.setSystemTime(29000);
    pending.forEach((d) => d.reject(new Error('cluster command wedged ~29s')));
    await Promise.all(calls);

    // Ring EMPTY despite a genuine 29s-tail wedge across 20 commands — the histogram would show it,
    // the watchdog's ring does not. This is why self-heal 0-fired for 3h and a human had to recycle.
    expect(countClusterDeadlineHits(20000, 29000)).toBe(0);

    const nowMs = 29000;
    let reconnects = 0;
    const deps: ClusterSelfHealDeps = {
      getInflight: () => getClusterInflight(), // 0, and it never sustained > 50 → inflight trigger dead
      getDeadlineHits: (w) => countClusterDeadlineHits(w, nowMs),
      resetDeadlineHits: () => resetClusterDeadlineHits(),
      reconnect: () => {
        reconnects++;
        return Promise.resolve();
      },
      now: () => nowMs,
      log: () => {},
      onReconnect: () => undefined,
    };
    const watchdog = new ClusterSelfHealWatchdog({ ...WATCHDOG_CFG }, deps);
    // Tick well past every window — nothing to trigger on.
    for (let t = 0; t < 5; t++) expect(watchdog.tick()).toBe(false);
    await flush();
    expect(reconnects).toBe(0);
  });
});
